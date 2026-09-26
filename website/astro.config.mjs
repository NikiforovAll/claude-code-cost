// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	site: 'https://nikiforovall.blog',
	base: '/claude-code-cost',
	devToolbar: { enabled: false },
	integrations: [
		starlight({
			title: 'Claude Code Cost',
			description: 'See what Claude Code costs you per day, project, session, and message.',
			favicon: '/favicon.svg',
			head: [
				{ tag: 'meta', attrs: { property: 'og:image', content: 'https://nikiforovall.blog/claude-code-cost/og.png' } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: 'https://nikiforovall.blog/claude-code-cost/og.png' } },
			],
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/NikiforovAll/claude-code-cost' }],
			editLink: { baseUrl: 'https://github.com/NikiforovAll/claude-code-cost/edit/main/website/' },
			customCss: ['./src/kit/kit.css'],
			components: {
				ThemeProvider: './src/components/ThemeProvider.astro',
				ThemeSelect: './src/components/ThemeSelect.astro',
			},
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'Getting started', slug: 'getting-started' },
						{ label: 'How costs are computed', slug: 'how-costs-are-computed' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Read the overview', slug: 'guides/overview' },
						{ label: 'Trace a project to a message', slug: 'guides/sessions' },
						{ label: 'Watch 5-hour blocks and burn rate', slug: 'guides/insights' },
						{ label: 'Choose a date range and project scope', slug: 'guides/ranges-and-scope' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Keyboard shortcuts', slug: 'reference/keyboard-shortcuts' },
						{ label: 'Configuration and CLI', slug: 'reference/configuration' },
						{ label: 'Run inside Claude Code Hub', slug: 'reference/claude-code-hub' },
						{ label: 'Troubleshooting', slug: 'reference/troubleshooting' },
					],
				},
			],
		}),
	],
});
