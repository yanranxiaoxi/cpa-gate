import antfu from '@antfu/eslint-config';

export default antfu(
	{
		stylistic: {
			indent: 'tab',
			quotes: 'single',
			semi: true,
		},

		typescript: true,

		ignores: [
			'public/**',
			'dist/**',
			'node_modules/**',
			'.eslintcache',
			'debug.log',
			'SPECS.md',
		],
	},
);
