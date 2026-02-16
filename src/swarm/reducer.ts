/**
 * Reducer — Aggregates batch results into a final output.
 *
 * Strategies:
 *   - concatenate: Join all results with separators
 *   - summarize:   Feed all results to an agent for summarization
 *   - hierarchical: Tree reduction — group results, summarize groups, then summarize summaries
 */

import { AgentConfig, TeamConfig } from '../lib/types';
import { invokeAgent } from '../lib/invoke';
import { log, emitEvent } from '../lib/logging';
import { SwarmConfig, SWARM_DEFAULTS } from './types';

export interface ReduceOptions {
    swarmId: string;
    jobId: string;
    config: SwarmConfig;
    agent: AgentConfig;
    agentId: string;
    workspacePath: string;
    agents: Record<string, AgentConfig>;
    teams: Record<string, TeamConfig>;
    userMessage: string;
}

/**
 * Reduce batch results into a single output.
 */
export async function reduceBatchResults(
    batchResults: string[],
    options: ReduceOptions
): Promise<string> {
    const strategy = options.config.reduce?.strategy || SWARM_DEFAULTS.reduce_strategy;

    log('INFO', `Swarm ${options.swarmId}: reducing ${batchResults.length} batch results with strategy '${strategy}'`);
    emitEvent('swarm_reduce_start', {
        swarmId: options.swarmId,
        jobId: options.jobId,
        strategy,
        batchCount: batchResults.length,
    });

    let result: string;

    switch (strategy) {
        case 'concatenate':
            result = reduceConcatenate(batchResults);
            break;
        case 'summarize':
            result = await reduceSummarize(batchResults, options);
            break;
        case 'hierarchical':
            result = await reduceHierarchical(batchResults, options);
            break;
        default:
            result = reduceConcatenate(batchResults);
    }

    emitEvent('swarm_reduce_done', {
        swarmId: options.swarmId,
        jobId: options.jobId,
        strategy,
        resultLength: result.length,
    });

    return result;
}

/**
 * Simple concatenation with batch separators.
 */
function reduceConcatenate(batchResults: string[]): string {
    if (batchResults.length === 1) return batchResults[0];

    return batchResults
        .map((result, i) => `## Batch ${i + 1} of ${batchResults.length}\n\n${result}`)
        .join('\n\n---\n\n');
}

/**
 * Feed all results to an agent for summarization.
 * If results are too large, falls through to hierarchical.
 */
async function reduceSummarize(
    batchResults: string[],
    options: ReduceOptions
): Promise<string> {
    const combined = reduceConcatenate(batchResults);

    // If combined results are very large, use hierarchical instead
    // (most models have context limits around 100-200k tokens)
    const estimatedTokens = combined.length / 4; // rough estimate
    if (estimatedTokens > 150000) {
        log('INFO', `Swarm ${options.swarmId}: results too large for single summarize (${estimatedTokens} est. tokens), using hierarchical`);
        return reduceHierarchical(batchResults, options);
    }

    const reducePrompt = buildReducePrompt(combined, batchResults.length, options);

    // Resolve which agent to use for reduction
    const reduceAgentId = options.config.reduce?.agent || options.agentId;
    const reduceAgent = options.agents[reduceAgentId] || options.agent;

    log('INFO', `Swarm ${options.swarmId}: summarizing ${batchResults.length} batches with agent @${reduceAgentId}`);

    try {
        return await invokeAgent(
            reduceAgent,
            reduceAgentId,
            reducePrompt,
            options.workspacePath,
            true, // fresh conversation
            options.agents,
            options.teams
        );
    } catch (error) {
        log('ERROR', `Swarm ${options.swarmId}: summarize failed: ${(error as Error).message}, falling back to concatenate`);
        return reduceConcatenate(batchResults);
    }
}

/**
 * Hierarchical tree reduction: group results, summarize each group,
 * then recursively reduce until we have a single result.
 *
 * For 100 batch results with fanin=20:
 *   Level 1: 100 → 5 group summaries
 *   Level 2: 5 → 1 final summary
 */
async function reduceHierarchical(
    batchResults: string[],
    options: ReduceOptions,
    level: number = 0
): Promise<string> {
    const fanin = SWARM_DEFAULTS.hierarchical_reduce_fanin;

    // Base case: few enough results to summarize in one pass
    if (batchResults.length <= fanin) {
        return reduceSummarize(batchResults, options);
    }

    log('INFO', `Swarm ${options.swarmId}: hierarchical reduce level ${level} — ${batchResults.length} results, fanin=${fanin}`);

    // Group results into chunks of fanin
    const groups: string[][] = [];
    for (let i = 0; i < batchResults.length; i += fanin) {
        groups.push(batchResults.slice(i, i + fanin));
    }

    // Summarize each group in parallel
    const groupSummaries = await Promise.all(
        groups.map(async (group, groupIndex) => {
            log('INFO', `Swarm ${options.swarmId}: reducing group ${groupIndex + 1}/${groups.length} (${group.length} results)`);

            const combined = reduceConcatenate(group);
            const prompt = buildReducePrompt(combined, group.length, options, level, groupIndex, groups.length);

            const reduceAgentId = options.config.reduce?.agent || options.agentId;
            const reduceAgent = options.agents[reduceAgentId] || options.agent;

            try {
                return await invokeAgent(
                    reduceAgent,
                    reduceAgentId,
                    prompt,
                    options.workspacePath,
                    true,
                    options.agents,
                    options.teams
                );
            } catch (error) {
                log('ERROR', `Swarm ${options.swarmId}: group ${groupIndex} reduce failed: ${(error as Error).message}`);
                // Return concatenated group on failure
                return combined;
            }
        })
    );

    // Recurse if still too many summaries
    if (groupSummaries.length > fanin) {
        return reduceHierarchical(groupSummaries, options, level + 1);
    }

    // Final reduction pass
    return reduceSummarize(groupSummaries, options);
}

/**
 * Build the reduce prompt with user's custom prompt or a sensible default.
 */
function buildReducePrompt(
    combinedResults: string,
    batchCount: number,
    options: ReduceOptions,
    level?: number,
    groupIndex?: number,
    totalGroups?: number
): string {
    const userReducePrompt = options.config.reduce?.prompt;

    let contextLine = `The following are results from processing ${batchCount} batch(es) of a large-scale task.`;
    if (level !== undefined && groupIndex !== undefined && totalGroups !== undefined) {
        contextLine = `The following are results from group ${groupIndex + 1} of ${totalGroups} (reduction level ${level + 1}), containing ${batchCount} batch results.`;
    }

    const instruction = userReducePrompt
        ? `${userReducePrompt}\n\n${contextLine}`
        : `${contextLine}\n\nPlease synthesize and consolidate these results into a clear, organized summary. Highlight key findings, patterns, and any items that need attention. Remove redundancy while preserving important details.`;

    const originalTask = `Original task: ${options.userMessage}`;

    return `${instruction}\n\n${originalTask}\n\n---\n\n${combinedResults}`;
}
