$dest = "C:\Users\middl\Documents\Obsidian\Michael\.obsidian\plugins\nexus"
Copy-Item main.js, connector.js, styles.css, manifest.json -Destination $dest
Write-Host "Deployed to $dest"
