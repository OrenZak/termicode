import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
	entryPoints: ['src/extension.ts'],
	bundle: true,
	outfile: 'dist/extension.js',
	platform: 'node',
	target: 'node18',
	format: 'cjs',
	external: ['vscode'],
	sourcemap: true,
	minify: !watch,
});

if (watch) {
	await ctx.watch();
	console.log('Watching for changes...');
} else {
	await ctx.rebuild();
	await ctx.dispose();
	console.log('Build complete.');
}
