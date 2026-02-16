/**
 * Batch Splitter — Resolves input items and splits them into batches.
 *
 * Input sources:
 *   1. Inline items from user message (JSON array or newline-separated)
 *   2. Shell command output (from swarm config or user message)
 *   3. File contents (attached or referenced)
 *
 * The splitter also handles template parameter extraction from the user message
 * to fill {{param}} placeholders in input commands.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import { SwarmConfig, SwarmBatch, SWARM_DEFAULTS } from './types';
import { log } from '../lib/logging';

/**
 * Extract {{param}} references from a template string and resolve them
 * from the user message. Supports simple key=value or positional args.
 *
 * Example: command = "gh pr list --repo {{repo}}"
 *          userMessage = "review PRs in owner/repo"
 *          → extracts "owner/repo" as the first unquoted path-like token
 */
export function resolveTemplateParams(template: string, userMessage: string): string {
    // Extract all {{param}} names
    const paramRegex = /\{\{(\w+)\}\}/g;
    let match: RegExpExecArray | null;
    const params: string[] = [];
    while ((match = paramRegex.exec(template)) !== null) {
        params.push(match[1]);
    }

    if (params.length === 0) return template;

    let resolved = template;

    // Try to extract key=value pairs from user message
    const kvRegex = /(\w+)\s*=\s*["']?([^\s"']+)["']?/g;
    const kvMap: Record<string, string> = {};
    let kvMatch: RegExpExecArray | null;
    while ((kvMatch = kvRegex.exec(userMessage)) !== null) {
        kvMap[kvMatch[1].toLowerCase()] = kvMatch[2];
    }

    for (const param of params) {
        if (kvMap[param.toLowerCase()]) {
            resolved = resolved.replace(`{{${param}}}`, kvMap[param.toLowerCase()]);
            continue;
        }

        // Try to find repo-like patterns (owner/name) for 'repo' param
        if (param === 'repo') {
            const repoMatch = userMessage.match(/\b([\w.-]+\/[\w.-]+)\b/);
            if (repoMatch) {
                resolved = resolved.replace(`{{${param}}}`, repoMatch[1]);
                continue;
            }
        }

        // Try to find number-like patterns for 'limit' param
        if (param === 'limit') {
            const numMatch = userMessage.match(/\b(\d{2,})\b/);
            if (numMatch) {
                resolved = resolved.replace(`{{${param}}}`, numMatch[1]);
                continue;
            }
        }

        // Try backtick-enclosed command in user message as override
        const backtickMatch = userMessage.match(/`([^`]+)`/);
        if (backtickMatch) {
            // If user provides a full command, replace the entire template command
            return backtickMatch[1];
        }
    }

    return resolved;
}

/**
 * Run a shell command and capture its stdout.
 */
async function runShellCommand(command: string, timeoutMs: number = 120000): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('sh', ['-c', command], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: timeoutMs,
        });

        let stdout = '';
        let stderr = '';

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });

        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(`Command exited with code ${code}: ${stderr.trim()}`));
            }
        });
    });
}

/**
 * Parse raw input into individual items.
 */
function parseItems(raw: string, type: 'lines' | 'json_array'): string[] {
    if (type === 'json_array') {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed.map(item =>
                    typeof item === 'string' ? item : JSON.stringify(item)
                );
            }
        } catch {
            // Fall through to line splitting
            log('WARN', 'Failed to parse JSON array input, falling back to line splitting');
        }
    }

    // Line-based: split by newlines, trim, filter empty
    return raw.split('\n').map(l => l.trim()).filter(Boolean);
}

/**
 * Try to extract inline items from the user message.
 * Detects JSON arrays, newline lists, and comma-separated lists.
 */
function extractInlineItems(message: string): string[] | null {
    // Try JSON array
    const jsonMatch = message.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed.map(item =>
                    typeof item === 'string' ? item : JSON.stringify(item)
                );
            }
        } catch {
            // Not valid JSON
        }
    }

    return null;
}

/**
 * Resolve input items for a swarm job.
 *
 * Priority:
 *   1. Inline items from user message (JSON array)
 *   2. Attached files
 *   3. Shell command from swarm config (with template params from user message)
 *   4. User message lines as items
 */
export async function resolveInputItems(
    config: SwarmConfig,
    userMessage: string,
    attachedFiles?: string[]
): Promise<string[]> {
    // 1. Check for inline items in user message
    const inlineItems = extractInlineItems(userMessage);
    if (inlineItems && inlineItems.length > 0) {
        log('INFO', `Swarm: resolved ${inlineItems.length} inline items from message`);
        return inlineItems;
    }

    // 2. Check attached files
    if (attachedFiles && attachedFiles.length > 0) {
        const allItems: string[] = [];
        for (const filePath of attachedFiles) {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                const type = config.input?.type || 'lines';
                allItems.push(...parseItems(content, type));
            }
        }
        if (allItems.length > 0) {
            log('INFO', `Swarm: resolved ${allItems.length} items from ${attachedFiles.length} attached file(s)`);
            return allItems;
        }
    }

    // 3. Run shell command from config
    if (config.input?.command) {
        const resolvedCommand = resolveTemplateParams(config.input.command, userMessage);
        log('INFO', `Swarm: running input command: ${resolvedCommand}`);

        const output = await runShellCommand(resolvedCommand);
        const type = config.input.type || 'lines';
        const items = parseItems(output, type);
        log('INFO', `Swarm: resolved ${items.length} items from command output`);
        return items;
    }

    // 4. Check for backtick-enclosed command in user message
    const backtickMatch = userMessage.match(/`([^`]+)`/);
    if (backtickMatch) {
        const command = backtickMatch[1];
        log('INFO', `Swarm: running inline command: ${command}`);
        const output = await runShellCommand(command);
        const type = config.input?.type || 'lines';
        const items = parseItems(output, type);
        log('INFO', `Swarm: resolved ${items.length} items from inline command`);
        return items;
    }

    // 5. Fall back to message lines as items
    const lines = userMessage.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 1) {
        log('INFO', `Swarm: using ${lines.length} message lines as items`);
        return lines;
    }

    return [];
}

/**
 * Split items into batches of the configured size.
 */
export function splitIntoBatches(items: string[], batchSize: number): SwarmBatch[] {
    const size = batchSize || SWARM_DEFAULTS.batch_size;
    const batches: SwarmBatch[] = [];

    for (let i = 0; i < items.length; i += size) {
        batches.push({
            index: batches.length,
            items: items.slice(i, i + size),
            status: 'pending',
            retries: 0,
        });
    }

    return batches;
}
