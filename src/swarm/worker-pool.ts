/**
 * Worker Pool — Processes swarm batches with bounded concurrency.
 *
 * Uses a semaphore pattern to limit how many batches run in parallel.
 * Each worker invokes the configured agent with a batch-specific prompt
 * generated from the swarm's prompt_template.
 */

import { AgentConfig, TeamConfig } from '../lib/types';
import { invokeAgent } from '../lib/invoke';
import { log, emitEvent } from '../lib/logging';
import { SwarmConfig, SwarmBatch, BatchResult, SWARM_DEFAULTS } from './types';

/**
 * Render the prompt template for a batch.
 *
 * Placeholders:
 *   {{items}}          — The batch items (one per line)
 *   {{items_json}}     — The batch items as a JSON array
 *   {{batch_index}}    — 0-based batch index
 *   {{batch_number}}   — 1-based batch number
 *   {{total_batches}}  — Total number of batches
 *   {{batch_size}}     — Number of items in this batch
 *   {{user_message}}   — The user's original message
 */
export function renderBatchPrompt(
    template: string,
    batch: SwarmBatch,
    totalBatches: number,
    userMessage: string
): string {
    return template
        .replace(/\{\{items\}\}/g, batch.items.join('\n'))
        .replace(/\{\{items_json\}\}/g, JSON.stringify(batch.items, null, 2))
        .replace(/\{\{batch_index\}\}/g, String(batch.index))
        .replace(/\{\{batch_number\}\}/g, String(batch.index + 1))
        .replace(/\{\{total_batches\}\}/g, String(totalBatches))
        .replace(/\{\{batch_size\}\}/g, String(batch.items.length))
        .replace(/\{\{user_message\}\}/g, userMessage);
}

/** Semaphore for bounding concurrency */
class Semaphore {
    private queue: (() => void)[] = [];
    private current = 0;

    constructor(private max: number) {}

    async acquire(): Promise<void> {
        if (this.current < this.max) {
            this.current++;
            return;
        }
        return new Promise<void>(resolve => {
            this.queue.push(resolve);
        });
    }

    release(): void {
        this.current--;
        const next = this.queue.shift();
        if (next) {
            this.current++;
            next();
        }
    }
}

export interface WorkerPoolOptions {
    swarmId: string;
    jobId: string;
    config: SwarmConfig;
    agent: AgentConfig;
    agentId: string;
    workspacePath: string;
    agents: Record<string, AgentConfig>;
    teams: Record<string, TeamConfig>;
    userMessage: string;
    /** Called after each batch completes */
    onBatchComplete?: (result: BatchResult, progress: { completed: number; total: number; failed: number }) => void;
}

/**
 * Process all batches through the worker pool.
 *
 * Returns results in batch index order (not completion order).
 * Failed batches are retried up to max_retries times.
 */
export async function processAllBatches(
    batches: SwarmBatch[],
    options: WorkerPoolOptions
): Promise<BatchResult[]> {
    const concurrency = options.config.concurrency || SWARM_DEFAULTS.concurrency;
    const maxRetries = SWARM_DEFAULTS.max_retries;
    const semaphore = new Semaphore(concurrency);
    const results: BatchResult[] = new Array(batches.length);

    let completed = 0;
    let failed = 0;

    log('INFO', `Swarm ${options.swarmId}: starting worker pool — ${batches.length} batches, concurrency=${concurrency}`);
    emitEvent('swarm_pool_start', {
        swarmId: options.swarmId,
        jobId: options.jobId,
        totalBatches: batches.length,
        concurrency,
    });

    const batchPromises = batches.map(async (batch) => {
        await semaphore.acquire();

        const startTime = Date.now();
        batch.status = 'processing';
        batch.startTime = startTime;

        const prompt = renderBatchPrompt(
            options.config.prompt_template,
            batch,
            batches.length,
            options.userMessage
        );

        let lastError: string | undefined;
        let success = false;
        let result: string | undefined;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 0) {
                    log('INFO', `Swarm ${options.swarmId}: retrying batch ${batch.index + 1}/${batches.length} (attempt ${attempt + 1})`);
                    // Exponential backoff: 2s, 4s
                    await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
                }

                emitEvent('swarm_batch_start', {
                    swarmId: options.swarmId,
                    jobId: options.jobId,
                    batchIndex: batch.index,
                    batchSize: batch.items.length,
                    attempt,
                });

                // Each batch starts a fresh conversation (shouldReset=true)
                // so batches don't interfere with each other
                result = await invokeAgent(
                    options.agent,
                    options.agentId,
                    prompt,
                    options.workspacePath,
                    true, // shouldReset — each batch is independent
                    options.agents,
                    options.teams
                );

                success = true;
                break;
            } catch (error) {
                lastError = (error as Error).message;
                batch.retries = attempt + 1;
                log('WARN', `Swarm ${options.swarmId}: batch ${batch.index + 1} failed (attempt ${attempt + 1}): ${lastError}`);
            }
        }

        const endTime = Date.now();
        batch.endTime = endTime;

        const batchResult: BatchResult = {
            batchIndex: batch.index,
            success,
            result: success ? result : undefined,
            error: success ? undefined : lastError,
            duration: endTime - startTime,
        };

        if (success) {
            batch.status = 'completed';
            batch.result = result;
            completed++;
        } else {
            batch.status = 'failed';
            batch.error = lastError;
            failed++;
        }

        results[batch.index] = batchResult;

        emitEvent('swarm_batch_done', {
            swarmId: options.swarmId,
            jobId: options.jobId,
            batchIndex: batch.index,
            success,
            duration: endTime - startTime,
            completed,
            failed,
            total: batches.length,
        });

        if (options.onBatchComplete) {
            options.onBatchComplete(batchResult, { completed, total: batches.length, failed });
        }

        semaphore.release();
    });

    await Promise.all(batchPromises);

    log('INFO', `Swarm ${options.swarmId}: worker pool done — ${completed} completed, ${failed} failed`);
    emitEvent('swarm_pool_done', {
        swarmId: options.swarmId,
        jobId: options.jobId,
        completed,
        failed,
        total: batches.length,
    });

    return results;
}
