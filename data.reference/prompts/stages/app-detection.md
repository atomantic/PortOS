Analyze this project and return JSON with the detected configuration.

Directory: {{dirName}}
Files: {{fileList}}

{{#packageJson}}
package.json:
{{packageJson}}
{{/packageJson}}

{{#configFiles}}
{{name}}:
{{content}}
{{/configFiles}}

{{#envFiles}}
{{name}}:
{{content}}
{{/envFiles}}

{{#readme}}
README excerpt:
{{readme}}
{{/readme}}

{{jsonOutputFormat}}

Return this exact structure:
{{appDetectionSchema}}

Rules:
- {{portDetectionRules}}
- {{pm2NamingConvention}}
- name: Use package.json name or derive from directory, make it human readable
- For startCommands, prefer "npm run dev" patterns
- If the app has both frontend and backend, suggest separate PM2 processes
