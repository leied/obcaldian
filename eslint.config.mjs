import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{
		ignores: [
			"main.js",
			"node_modules/**",
			"sample-app/**",
			"scripts/**",
			"tests/**",
			"vitest.config.ts",
		],
	},
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.*", "*.mjs", "scripts/*.mjs"],
				},
			},
		},
		rules: {
			"obsidianmd/ui/sentence-case": "off",
		},
	},
	{
		files: ["src/settingsTab.ts"],
		rules: {
			// Obsidian 1.11.4 requires display(); the declarative API is 1.13+.
			"@typescript-eslint/no-deprecated": "off",
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
		},
	},
]);
