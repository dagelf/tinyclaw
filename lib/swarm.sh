#!/usr/bin/env bash
# Swarm management functions for TinyClaw
# Swarms are map-reduce orchestrations for large-scale parallel work

# List all configured swarms
swarm_list() {
    if [ ! -f "$SETTINGS_FILE" ]; then
        echo -e "${RED}No settings file found. Run setup first.${NC}"
        exit 1
    fi

    local swarms_count
    swarms_count=$(jq -r '(.swarms // {}) | length' "$SETTINGS_FILE" 2>/dev/null)

    if [ "$swarms_count" = "0" ] || [ -z "$swarms_count" ]; then
        echo -e "${YELLOW}No swarms configured.${NC}"
        echo ""
        echo "Add a swarm with:"
        echo -e "  ${GREEN}$0 swarm add${NC}"
        return
    fi

    echo -e "${BLUE}Configured Swarms${NC}"
    echo "=================="
    echo ""

    jq -r '(.swarms // {}) | to_entries[] | "\(.key)|\(.value.name)|\(.value.agent)|\(.value.concurrency // 5)|\(.value.batch_size // 25)|\(.value.reduce.strategy // "concatenate")"' "$SETTINGS_FILE" 2>/dev/null | \
    while IFS='|' read -r id name agent concurrency batch_size strategy; do
        echo -e "  ${GREEN}@${id}${NC} - ${name}"
        echo "    Agent:       @${agent}"
        echo "    Concurrency: ${concurrency} workers"
        echo "    Batch size:  ${batch_size} items"
        echo "    Reduce:      ${strategy}"
        echo ""
    done

    echo "Usage: Send '@swarm_id <message>' in any channel to trigger a swarm job."
}

# Show details for a specific swarm
swarm_show() {
    local swarm_id="$1"

    if [ ! -f "$SETTINGS_FILE" ]; then
        echo -e "${RED}No settings file found.${NC}"
        exit 1
    fi

    local swarm_json
    swarm_json=$(jq -r "(.swarms // {}).\"${swarm_id}\" // empty" "$SETTINGS_FILE" 2>/dev/null)

    if [ -z "$swarm_json" ]; then
        echo -e "${RED}Swarm '${swarm_id}' not found.${NC}"
        echo ""
        echo "Available swarms:"
        jq -r '(.swarms // {}) | keys[]' "$SETTINGS_FILE" 2>/dev/null | while read -r id; do
            echo "  @${id}"
        done
        exit 1
    fi

    echo -e "${BLUE}Swarm: @${swarm_id}${NC}"
    echo ""
    jq "(.swarms // {}).\"${swarm_id}\"" "$SETTINGS_FILE" 2>/dev/null
}

# Add a new swarm interactively
swarm_add() {
    if [ ! -f "$SETTINGS_FILE" ]; then
        echo -e "${RED}No settings file found. Run setup first.${NC}"
        exit 1
    fi

    echo -e "${BLUE}Add New Swarm${NC}"
    echo ""

    # Swarm ID
    read -rp "Swarm ID (lowercase, no spaces, e.g. 'pr-reviewer'): " SWARM_ID
    SWARM_ID=$(echo "$SWARM_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')
    if [ -z "$SWARM_ID" ]; then
        echo -e "${RED}Invalid swarm ID${NC}"
        exit 1
    fi

    # Check if exists
    local existing
    existing=$(jq -r "(.swarms // {}).\"${SWARM_ID}\" // empty" "$SETTINGS_FILE" 2>/dev/null)
    if [ -n "$existing" ]; then
        echo -e "${RED}Swarm '${SWARM_ID}' already exists. Use 'swarm remove ${SWARM_ID}' first.${NC}"
        exit 1
    fi

    # Check namespace collision with agents and teams
    local agent_collision team_collision
    agent_collision=$(jq -r "(.agents // {}).\"${SWARM_ID}\" // empty" "$SETTINGS_FILE" 2>/dev/null)
    team_collision=$(jq -r "(.teams // {}).\"${SWARM_ID}\" // empty" "$SETTINGS_FILE" 2>/dev/null)
    if [ -n "$agent_collision" ] || [ -n "$team_collision" ]; then
        echo -e "${RED}'${SWARM_ID}' is already used as an agent or team ID. Swarm, agent, and team IDs share the same namespace.${NC}"
        exit 1
    fi

    # Swarm name
    read -rp "Display name (e.g. 'PR Reviewer'): " SWARM_NAME
    if [ -z "$SWARM_NAME" ]; then
        SWARM_NAME="$SWARM_ID"
    fi

    # Show available agents
    echo ""
    echo -e "${BLUE}Available Agents:${NC}"
    jq -r '(.agents // {}) | to_entries[] | "  @\(.key) - \(.value.name)"' "$SETTINGS_FILE" 2>/dev/null

    echo ""
    read -rp "Worker agent ID (will process each batch): " SWARM_AGENT
    SWARM_AGENT=$(echo "$SWARM_AGENT" | tr -d ' @' | tr '[:upper:]' '[:lower:]')

    # Validate agent exists
    local agent_json
    agent_json=$(jq -r "(.agents // {}).\"${SWARM_AGENT}\" // empty" "$SETTINGS_FILE" 2>/dev/null)
    if [ -z "$agent_json" ]; then
        echo -e "${RED}Agent '${SWARM_AGENT}' not found.${NC}"
        exit 1
    fi

    # Concurrency
    echo ""
    read -rp "Max concurrent workers [default: 5]: " SWARM_CONCURRENCY
    SWARM_CONCURRENCY=${SWARM_CONCURRENCY:-5}

    # Batch size
    read -rp "Items per batch [default: 25]: " SWARM_BATCH_SIZE
    SWARM_BATCH_SIZE=${SWARM_BATCH_SIZE:-25}

    # Input command (optional)
    echo ""
    echo "Input command (optional — shell command to generate items):"
    echo "  Use {{param}} for template parameters extracted from user message."
    echo "  Example: gh pr list --repo {{repo}} --limit 5000 --json number,title,url"
    echo ""
    read -rp "Input command (leave empty for inline/file input): " SWARM_INPUT_CMD

    # Input type
    local SWARM_INPUT_TYPE="lines"
    if [ -n "$SWARM_INPUT_CMD" ]; then
        echo ""
        echo "Input format:"
        echo "  1) Lines (one item per line)"
        echo "  2) JSON array"
        read -rp "Choose [1-2, default: 1]: " INPUT_TYPE_CHOICE
        case "$INPUT_TYPE_CHOICE" in
            2) SWARM_INPUT_TYPE="json_array" ;;
            *) SWARM_INPUT_TYPE="lines" ;;
        esac
    fi

    # Prompt template
    echo ""
    echo "Prompt template for each batch:"
    echo "  Available placeholders: {{items}}, {{items_json}}, {{batch_number}}, {{total_batches}}, {{user_message}}"
    echo ""
    read -rp "Prompt template: " SWARM_PROMPT

    if [ -z "$SWARM_PROMPT" ]; then
        SWARM_PROMPT="Process the following items:\n\n{{items}}"
    fi

    # Reduce strategy
    echo ""
    echo "Reduce strategy (how to aggregate batch results):"
    echo "  1) Concatenate (join all results)"
    echo "  2) Summarize (agent summarizes all results)"
    echo "  3) Hierarchical (tree reduction for very large outputs)"
    read -rp "Choose [1-3, default: 1]: " REDUCE_CHOICE

    local SWARM_REDUCE_STRATEGY="concatenate"
    local SWARM_REDUCE_PROMPT=""
    case "$REDUCE_CHOICE" in
        2)
            SWARM_REDUCE_STRATEGY="summarize"
            read -rp "Custom reduce prompt (optional): " SWARM_REDUCE_PROMPT
            ;;
        3)
            SWARM_REDUCE_STRATEGY="hierarchical"
            read -rp "Custom reduce prompt (optional): " SWARM_REDUCE_PROMPT
            ;;
        *)
            SWARM_REDUCE_STRATEGY="concatenate"
            ;;
    esac

    # Build the swarm JSON object
    local swarm_json
    local input_json="{}"
    if [ -n "$SWARM_INPUT_CMD" ]; then
        input_json=$(jq -n --arg cmd "$SWARM_INPUT_CMD" --arg type "$SWARM_INPUT_TYPE" '{ command: $cmd, type: $type }')
    fi

    local reduce_json
    if [ -n "$SWARM_REDUCE_PROMPT" ]; then
        reduce_json=$(jq -n --arg strategy "$SWARM_REDUCE_STRATEGY" --arg prompt "$SWARM_REDUCE_PROMPT" '{ strategy: $strategy, prompt: $prompt }')
    else
        reduce_json=$(jq -n --arg strategy "$SWARM_REDUCE_STRATEGY" '{ strategy: $strategy }')
    fi

    swarm_json=$(jq -n \
        --arg name "$SWARM_NAME" \
        --arg agent "$SWARM_AGENT" \
        --argjson concurrency "$SWARM_CONCURRENCY" \
        --argjson batch_size "$SWARM_BATCH_SIZE" \
        --argjson input "$input_json" \
        --arg prompt "$SWARM_PROMPT" \
        --argjson reduce "$reduce_json" \
        '{
            name: $name,
            agent: $agent,
            concurrency: $concurrency,
            batch_size: $batch_size,
            input: $input,
            prompt_template: $prompt,
            reduce: $reduce
        }')

    # Write to settings
    local tmp_file="$SETTINGS_FILE.tmp"
    jq --arg id "$SWARM_ID" --argjson swarm "$swarm_json" \
        '.swarms //= {} | .swarms[$id] = $swarm' \
        "$SETTINGS_FILE" > "$tmp_file" && mv "$tmp_file" "$SETTINGS_FILE"

    echo ""
    echo -e "${GREEN}Swarm '${SWARM_ID}' created!${NC}"
    echo ""
    echo -e "${BLUE}Configuration:${NC}"
    echo "  Name:        $SWARM_NAME"
    echo "  Agent:       @$SWARM_AGENT"
    echo "  Concurrency: $SWARM_CONCURRENCY workers"
    echo "  Batch size:  $SWARM_BATCH_SIZE items"
    echo "  Reduce:      $SWARM_REDUCE_STRATEGY"
    echo ""
    echo -e "${BLUE}Next steps:${NC}"
    echo "  Trigger the swarm: '@${SWARM_ID} <your task description>' in any channel"
    echo ""
    echo "Note: Changes take effect on next message. Restart is not required."
}

# Remove a swarm
swarm_remove() {
    local swarm_id="$1"

    if [ ! -f "$SETTINGS_FILE" ]; then
        echo -e "${RED}No settings file found.${NC}"
        exit 1
    fi

    local swarm_json
    swarm_json=$(jq -r "(.swarms // {}).\"${swarm_id}\" // empty" "$SETTINGS_FILE" 2>/dev/null)

    if [ -z "$swarm_json" ]; then
        echo -e "${RED}Swarm '${swarm_id}' not found.${NC}"
        exit 1
    fi

    local swarm_name
    swarm_name=$(jq -r "(.swarms // {}).\"${swarm_id}\".name" "$SETTINGS_FILE" 2>/dev/null)

    read -rp "Remove swarm '${swarm_id}' (${swarm_name})? [y/N]: " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[yY] ]]; then
        echo "Cancelled."
        return
    fi

    local tmp_file="$SETTINGS_FILE.tmp"
    jq --arg id "$swarm_id" 'del(.swarms[$id])' "$SETTINGS_FILE" > "$tmp_file" && mv "$tmp_file" "$SETTINGS_FILE"

    echo -e "${GREEN}Swarm '${swarm_id}' removed.${NC}"
}

# Trigger a swarm job from CLI
swarm_run() {
    local swarm_id="$1"
    shift
    local message="$*"

    if [ ! -f "$SETTINGS_FILE" ]; then
        echo -e "${RED}No settings file found.${NC}"
        exit 1
    fi

    local swarm_json
    swarm_json=$(jq -r "(.swarms // {}).\"${swarm_id}\" // empty" "$SETTINGS_FILE" 2>/dev/null)

    if [ -z "$swarm_json" ]; then
        echo -e "${RED}Swarm '${swarm_id}' not found.${NC}"
        echo ""
        echo "Available swarms:"
        jq -r '(.swarms // {}) | keys[]' "$SETTINGS_FILE" 2>/dev/null | while read -r id; do
            echo "  @${id}"
        done
        exit 1
    fi

    if [ -z "$message" ]; then
        echo "Usage: $0 swarm run <swarm_id> <message>"
        echo ""
        echo "Example:"
        echo "  $0 swarm run pr-reviewer 'review PRs in owner/repo'"
        exit 1
    fi

    # Enqueue as a message routed to the swarm
    local queue_dir="$TINYCLAW_HOME/queue/incoming"
    mkdir -p "$queue_dir"

    local msg_id="cli_swarm_$(date +%s)_$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' ')"
    local msg_file="$queue_dir/${msg_id}.json"

    jq -n \
        --arg channel "cli" \
        --arg sender "cli" \
        --arg message "@${swarm_id} ${message}" \
        --argjson timestamp "$(date +%s000)" \
        --arg messageId "$msg_id" \
        '{
            channel: $channel,
            sender: $sender,
            message: $message,
            timestamp: $timestamp,
            messageId: $messageId
        }' > "$msg_file"

    local swarm_name
    swarm_name=$(jq -r "(.swarms // {}).\"${swarm_id}\".name" "$SETTINGS_FILE" 2>/dev/null)

    echo -e "${GREEN}Swarm job queued: ${swarm_name} (@${swarm_id})${NC}"
    echo "  Message: ${message}"
    echo ""
    echo "Monitor progress in the queue logs:"
    echo "  $0 logs queue"
}
