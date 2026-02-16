/**
 * Agent Swarm Types
 *
 * A swarm is an orchestration primitive for large-scale parallel work.
 * Unlike teams (collaborative), swarms handle data parallelism:
 * processing many similar items concurrently via map-reduce.
 *
 * Flow: Input → Split → Map (parallel batches) → Reduce → Output
 */

/**
 * Swarm configuration — defined in settings.json under "swarms".
 *
 * Example:
 * {
 *   "swarms": {
 *     "pr-reviewer": {
 *       "name": "PR Reviewer",
 *       "agent": "coder",
 *       "concurrency": 10,
 *       "batch_size": 25,
 *       "input": {
 *         "command": "gh pr list --repo {{repo}} --limit 5000 --json number,title,url,additions,deletions,changedFiles",
 *         "type": "json_array"
 *       },
 *       "prompt_template": "Review each PR and provide: summary, risk level (low/medium/high), and recommended action.\n\nPRs:\n{{items}}",
 *       "reduce": {
 *         "strategy": "hierarchical",
 *         "prompt": "Compile these PR reviews into a prioritized report grouped by risk level."
 *       }
 *     }
 *   }
 * }
 */
export interface SwarmConfig {
    name: string;
    description?: string;

    /** Agent ID from the agents config to use as worker template */
    agent: string;

    /** Max concurrent workers (default: 5) */
    concurrency?: number;

    /** Items per batch (default: 25) */
    batch_size?: number;

    /** How to obtain input items */
    input?: {
        /** Shell command to generate items. Supports {{param}} placeholders from user message. */
        command?: string;
        /** How to parse command output: 'lines' (one item per line) or 'json_array' (JSON array) */
        type?: 'lines' | 'json_array';
    };

    /** Prompt template for each batch. {{items}} = batch items, {{batch_index}} = batch number, {{total_batches}} = total */
    prompt_template: string;

    /** How to aggregate batch results */
    reduce?: {
        /** 'concatenate' = join results, 'summarize' = agent summarizes, 'hierarchical' = tree reduction */
        strategy?: 'concatenate' | 'summarize' | 'hierarchical';
        /** Prompt for summarize/hierarchical reduction */
        prompt?: string;
        /** Agent ID for reduction (defaults to swarm agent) */
        agent?: string;
    };

    /** Send progress updates to channel every N batches (0 = no updates) */
    progress_interval?: number;
}

/** A single batch of items to process */
export interface SwarmBatch {
    index: number;
    items: string[];
    status: 'pending' | 'processing' | 'completed' | 'failed';
    result?: string;
    error?: string;
    startTime?: number;
    endTime?: number;
    retries: number;
}

/** Progress snapshot for a swarm job */
export interface SwarmProgress {
    total: number;
    completed: number;
    failed: number;
    inFlight: number;
    startTime: number;
    endTime?: number;
    /** Estimated seconds remaining based on current throughput */
    estimatedRemaining?: number;
}

/** A running swarm job */
export interface SwarmJob {
    id: string;
    swarmId: string;
    config: SwarmConfig;
    status: 'initializing' | 'fetching_input' | 'splitting' | 'processing' | 'reducing' | 'completed' | 'failed';
    batches: SwarmBatch[];
    progress: SwarmProgress;
    /** Raw input items before batching */
    inputItems?: string[];
    /** Aggregated batch results before reduction */
    batchResults?: string[];
    /** Final reduced output */
    result?: string;
    error?: string;
    /** Channel/sender context for sending progress updates */
    context: SwarmJobContext;
}

/** Context for routing swarm results back to the user */
export interface SwarmJobContext {
    channel: string;
    sender: string;
    senderId?: string;
    messageId: string;
    /** User's original message (for parameter extraction) */
    originalMessage: string;
}

/** Result from the worker pool for a single batch */
export interface BatchResult {
    batchIndex: number;
    success: boolean;
    result?: string;
    error?: string;
    duration: number;
}

/** Swarm defaults */
export const SWARM_DEFAULTS = {
    concurrency: 5,
    batch_size: 25,
    reduce_strategy: 'concatenate' as const,
    progress_interval: 10,
    max_retries: 2,
    /** Max items a single swarm can process */
    max_items: 10000,
    /** Max batch results to feed into a single reduce step */
    hierarchical_reduce_fanin: 20,
};
