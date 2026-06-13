#!/bin/bash

# BridgeSync: Claude Code & VS Code Migration Utility
echo "========================================================"
echo "  BridgeSync: Claude Code & VS Code Migration Utility"
echo "========================================================"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed. Please install Node.js first."
    exit 1
fi

# Install dependencies if missing
if [ ! -d "node_modules" ]; then
    echo "Installing required Node.js packages (express, multer)..."
    npm install
fi

# Start the server and open the browser
echo ""
echo "Launching local server at http://localhost:3000 ..."

# Open browser based on OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    open "http://localhost:3000"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if command -v xdg-open &> /dev/null; then
        xdg-open "http://localhost:3000"
    elif command -v sensible-browser &> /dev/null; then
        sensible-browser "http://localhost:3000"
    fi
fi

echo ""
echo "Server running. Press Ctrl+C to stop the BridgeSync tool."
echo "========================================================"
node server.js
