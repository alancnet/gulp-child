#!/bin/bash

# Global array to hold destinations
DESTINATIONS=(
    "/home/ubuntu/git/jobot-com/node_modules/gulp-child/"
    "/home/ubuntu/git/jobot-com/jobot-com-api/node_modules/gulp-child/"
    "/home/ubuntu/git/jobot-com/jobot-core/node_modules/gulp-child/"
    "/home/ubuntu/git/jobot-com/jobot-com-www/node_modules/gulp-child/"
)

# Function to execute when changes are detected
function on_file_change() {
    echo "File change detected: $1"

    for dest in "${DESTINATIONS[@]}"; do
        # Copy only files
        for item in *; do
            if [ -f "$item" ]; then
                echo "Copying $item to $dest"
                cp "$item" "$dest"
            fi
        done
    done
}


on_file_change "Initial copy"

# Convert array to string for inotifywait
watch_dirs="./ ${DESTINATIONS[*]}"

# Watch for file changes using inotifywait
while true; do
    change=$(inotifywait -r -e modify,create,delete $watch_dirs 2>/dev/null)
    change=${change%% *}

    if [ -n "$change" ]; then
        on_file_change "$change"
    else
        echo "Skipping duplicate change: $change"
    fi
done