# postbuild.ps1
# Deploys built plugin artifacts to the Michael vault and restarts Obsidian.

$PLUGIN_DIR = "C:\Users\middl\Documents\Obsidian\Michael\.obsidian\plugins\nexus"

Write-Host "Copying artifacts to $PLUGIN_DIR..."
Copy-Item ".\main.js"      "$PLUGIN_DIR\main.js"      -Force
Copy-Item ".\connector.js" "$PLUGIN_DIR\connector.js" -Force
Copy-Item ".\manifest.json" "$PLUGIN_DIR\manifest.json" -Force
Copy-Item ".\styles.css"   "$PLUGIN_DIR\styles.css"   -Force

Write-Host "Stopping Obsidian (if running)..."
Stop-Process -Name "Obsidian" -ErrorAction SilentlyContinue

Start-Sleep -Seconds 1

Write-Host "Starting Obsidian..."
Start-Process "C:\Program Files\Obsidian\Obsidian.exe"

Write-Host "Done!"
