import fs from 'fs';
import path from 'path';
import { rimraf } from '../filesystem/index.js';
import create_manifest_data from '../../core/create_manifest_data/index.js';
import { copy_assets, get_no_external, posixify, resolve_entry } from '../utils.js';
import { create_app } from '../../core/create_app/index.js';
import vite from 'vite';
import svelte from '@sveltejs/vite-plugin-svelte';
import glob from 'tiny-glob/sync.js';

/** @param {any} value */
const s = (value) => JSON.stringify(value);

/** @typedef {Record<string, {
 *   file: string;
 *   css: string[];
 *   imports: string[];
 * }>} ClientManifest */

/**
 * @param {import('types/config').ValidatedConfig} config
 * @param {{
 *   cwd?: string;
 *   runtime?: string;
 * }} [opts]
 * @returns {Promise<import('types/internal').BuildData>}
 */
export async function build(config, { cwd = process.cwd(), runtime = '@sveltejs/kit/ssr' } = {}) {
	const build_dir = path.resolve(cwd, '.svelte/build');

	rimraf(build_dir);

	const output_dir = path.resolve(cwd, '.svelte/output');

	const options = {
		cwd,
		config,
		build_dir,
		base:
			config.kit.paths.assets === '/.'
				? `/${config.kit.appDir}/`
				: `${config.kit.paths.assets}/${config.kit.appDir}/`,
		manifest: create_manifest_data({
			config,
			output: build_dir,
			cwd
		}),
		output_dir,
		client_entry_file: '.svelte/build/runtime/internal/start.js',
		service_worker_entry_file: resolve_entry(config.kit.files.serviceWorker)
	};

	const client_manifest = await build_client(options);
	await build_server(options, client_manifest, runtime);

	if (options.service_worker_entry_file) {
		const { base, assets } = config.kit.paths;

		if (assets !== base && assets !== '/.') {
			throw new Error('Cannot use service worker alongside config.kit.paths.assets');
		}

		await build_service_worker(options, client_manifest);
	}

	const client = glob('**', { cwd: `${output_dir}/client`, filesOnly: true }).map(posixify);
	const server = glob('**', { cwd: `${output_dir}/server`, filesOnly: true }).map(posixify);

	return {
		client,
		server,
		static: options.manifest.assets.map((asset) => posixify(asset.file)),
		entries: options.manifest.routes
			.map((route) => route.type === 'page' && route.path)
			.filter(Boolean)
	};
}

/**
 * @param {{
 *   cwd: string;
 *   base: string;
 *   config: import('types/config').ValidatedConfig
 *   manifest: import('types/internal').ManifestData
 *   build_dir: string;
 *   output_dir: string;
 *   client_entry_file: string;
 *   service_worker_entry_file: string;
 * }} options
 */
async function build_client({
	cwd,
	base,
	config,
	manifest,
	build_dir,
	output_dir,
	client_entry_file,
	service_worker_entry_file
}) {
	create_app({
		manifest_data: manifest,
		output: build_dir,
		cwd
	});

	copy_assets(build_dir);

	process.env.VITE_SVELTEKIT_AMP = config.kit.amp ? 'true' : '';
	process.env.VITE_SVELTEKIT_SERVICE_WORKER = service_worker_entry_file ? '/service-worker.js' : '';

	const client_out_dir = `${output_dir}/client/${config.kit.appDir}`;
	const client_manifest_file = `${client_out_dir}/manifest.json`;

	/** @type {Record<string, string>} */
	const input = {
		start: path.resolve(cwd, client_entry_file)
	};

	// This step is optional — Vite/Rollup will create the necessary chunks
	// for everything regardless — but it means that entry chunks reflect
	// their location in the source code, which is helpful for debugging
	manifest.components.forEach((file) => {
		const resolved = path.resolve(cwd, file);
		const relative = path.relative(config.kit.files.routes, resolved);

		const name = relative.startsWith('..')
			? path.basename(file)
			: posixify(path.join('pages', relative));
		input[name] = resolved;
	});

	/** @type {any} */
	const user_config = config.kit.vite();

	await vite.build({
		...user_config,
		configFile: false,
		root: cwd,
		base,
		build: {
			...user_config.build,
			cssCodeSplit: true,
			manifest: true,
			outDir: client_out_dir,
			polyfillDynamicImport: false,
			rollupOptions: {
				...(user_config.build && user_config.build.rollupOptions),
				input,
				output: {
					entryFileNames: '[name]-[hash].js',
					chunkFileNames: 'chunks/[name]-[hash].js',
					assetFileNames: 'assets/[name]-[hash][extname]'
				},
				preserveEntrySignatures: 'strict'
			}
		},
		resolve: {
			...user_config.resolve,
			alias: {
				...(user_config.resolve && user_config.resolve.alias),
				$app: path.resolve(`${build_dir}/runtime/app`),
				$lib: config.kit.files.lib
			}
		},
		plugins: [
			...(user_config.plugins || []),
			svelte({
				extensions: config.extensions
			})
		]
	});

	/** @type {ClientManifest} */
	const client_manifest = JSON.parse(fs.readFileSync(client_manifest_file, 'utf-8'));
	fs.renameSync(client_manifest_file, `${output_dir}/manifest.json`); // inspectable but not shipped

	return client_manifest;
}

/**
 * @param {{
 *   cwd: string;
 *   base: string;
 *   config: import('types/config').ValidatedConfig
 *   manifest: import('types/internal').ManifestData
 *   build_dir: string;
 *   output_dir: string;
 *   client_entry_file: string;
 *   service_worker_entry_file: string;
 * }} options
 * @param {ClientManifest} client_manifest
 * @param {string} runtime
 */
async function build_server(
	{ cwd, base, config, manifest, build_dir, output_dir, client_entry_file },
	client_manifest,
	runtime
) {
	let hooks_file = resolve_entry(config.kit.files.hooks);
	if (!fs.existsSync(hooks_file)) {
		hooks_file = path.resolve(cwd, '.svelte/build/hooks.js');
		fs.writeFileSync(hooks_file, '');
	}

	const app_file = `${build_dir}/app.js`;

	/** @type {(file: string) => string} */
	const app_relative = (file) => {
		const relative_file = path.relative(build_dir, path.resolve(cwd, file));
		return relative_file[0] === '.' ? relative_file : `./${relative_file}`;
	};

	const prefix = `${config.kit.paths.assets}/${config.kit.appDir}/`;

	/**
	 * @param {string} file
	 * @param {Set<string>} js_deps
	 * @param {Set<string>} css_deps
	 */
	function find_deps(file, js_deps, css_deps) {
		const chunk = client_manifest[file];

		if (js_deps.has(chunk.file)) return;
		js_deps.add(chunk.file);

		if (chunk.css) {
			chunk.css.forEach((file) => css_deps.add(file));
		}

		if (chunk.imports) {
			chunk.imports.forEach((file) => find_deps(file, js_deps, css_deps));
		}
	}

	/** @type {Record<string, { entry: string, css: string[], js: string[], styles: string[] }>} */
	const metadata_lookup = {};

	manifest.components.forEach((file) => {
		const js_deps = new Set();
		const css_deps = new Set();

		find_deps(file, js_deps, css_deps);

		const js = Array.from(js_deps).map((url) => prefix + url);
		const css = Array.from(css_deps).map((url) => prefix + url);

		const styles = config.kit.amp
			? Array.from(css_deps).map((url) => {
					const resolved = `${output_dir}/client/${config.kit.appDir}/${url}`;
					return fs.readFileSync(resolved, 'utf-8');
			  })
			: null;

		metadata_lookup[file] = {
			entry: prefix + client_manifest[file].file,
			css,
			js,
			styles
		};
	});

	/** @type {Set<string>} */
	const entry_js = new Set();
	/** @type {Set<string>} */
	const entry_css = new Set();

	find_deps(client_entry_file, entry_js, entry_css);

	// prettier-ignore
	fs.writeFileSync(
		app_file,
		`
			import { respond } from '${runtime}';
			import root from './generated/root.svelte';
			import { set_paths } from './runtime/paths.js';
			import { set_prerendering } from './runtime/env.js';
			import * as user_hooks from ${s(app_relative(hooks_file))};

			const template = ({ head, body }) => ${s(fs.readFileSync(config.kit.files.template, 'utf-8'))
				.replace('%svelte.head%', '" + head + "')
				.replace('%svelte.body%', '" + body + "')};

			let options = null;

			// allow paths to be overridden in svelte-kit preview
			// and in prerendering
			export function init(settings) {
				set_paths(settings.paths);
				set_prerendering(settings.prerendering || false);

				options = {
					amp: ${config.kit.amp},
					dev: false,
					entry: {
						file: ${s(prefix + client_manifest[client_entry_file].file)},
						css: ${s(Array.from(entry_css).map(dep => prefix + dep))},
						js: ${s(Array.from(entry_js).map(dep => prefix + dep))}
					},
					fetched: undefined,
					get_component_path: id => ${s(`${config.kit.paths.assets}/${config.kit.appDir}/`)} + entry_lookup[id],
					get_stack: error => String(error), // for security
					handle_error: error => {
						console.error(error.stack);
						error.stack = options.get_stack(error);
					},
					hooks: get_hooks(user_hooks),
					hydrate: ${s(config.kit.hydrate)},
					initiator: undefined,
					load_component,
					manifest,
					paths: settings.paths,
					read: settings.read,
					root,
					router: ${s(config.kit.router)},
					ssr: ${s(config.kit.ssr)},
					target: ${s(config.kit.target)},
					template
				};
			}

			const d = decodeURIComponent;
			const empty = () => ({});

			const manifest = {
				assets: ${s(manifest.assets)},
				layout: ${s(manifest.layout)},
				error: ${s(manifest.error)},
				routes: [
					${manifest.routes
				.map((route) => {
					if (route.type === 'page') {
						const params = get_params(route.params);

						return `{
									type: 'page',
									pattern: ${route.pattern},
									params: ${params},
									a: [${route.a.map(file => file && s(file)).join(', ')}],
									b: [${route.b.map(file => file && s(file)).join(', ')}]
								}`;
					} else {
						const params = get_params(route.params);
						const load = `() => import(${s(app_relative(route.file))})`;

						return `{
									type: 'endpoint',
									pattern: ${route.pattern},
									params: ${params},
									load: ${load}
								}`;
					}
				})
				.join(',\n\t\t\t\t\t')}
				]
			};

			// this looks redundant, but the indirection allows us to access
			// named imports without triggering Rollup's missing import detection
			const get_hooks = hooks => ({
				getContext: hooks.getContext || (() => ({})),
				getSession: hooks.getSession || (() => ({})),
				handle: hooks.handle || (({ request, render }) => render(request))
			});

			const module_lookup = {
				${manifest.components.map(file => `${s(file)}: () => import(${s(app_relative(file))})`)}
			};

			const metadata_lookup = ${s(metadata_lookup)};

			async function load_component(file) {
				return {
					module: await module_lookup[file](),
					...metadata_lookup[file]
				};
			}

			init({ paths: ${s(config.kit.paths)} });

			export function render(request, {
				prerender
			} = {}) {
				const host = ${config.kit.host ? s(config.kit.host) : `request.headers[${s(config.kit.hostHeader || 'host')}]`};
				return respond({ ...request, host }, options, { prerender });
			}
		`
			.replace(/^\t{3}/gm, '')
			.trim()
	);

	/** @type {any} */
	const user_config = config.kit.vite();

	await vite.build({
		...user_config,
		configFile: false,
		root: cwd,
		base,
		build: {
			target: 'es2018',
			...user_config.build,
			ssr: true,
			outDir: `${output_dir}/server`,
			polyfillDynamicImport: false,
			rollupOptions: {
				...(user_config.build && user_config.build.rollupOptions),
				input: {
					app: app_file
				},
				output: {
					format: 'esm',
					entryFileNames: '[name].js',
					chunkFileNames: 'chunks/[name]-[hash].js',
					assetFileNames: 'assets/[name]-[hash][extname]',
					inlineDynamicImports: true
				},
				preserveEntrySignatures: 'strict'
			}
		},
		resolve: {
			...user_config.resolve,
			alias: {
				...(user_config.resolve && user_config.resolve.alias),
				$app: path.resolve(`${build_dir}/runtime/app`),
				$lib: config.kit.files.lib
			}
		},
		plugins: [
			...(user_config.plugins || []),
			svelte({
				extensions: config.extensions
			})
		],
		// this API is marked as @alpha https://github.com/vitejs/vite/blob/27785f7fcc5b45987b5f0bf308137ddbdd9f79ea/packages/vite/src/node/config.ts#L129
		// it's not exposed in the typescript definitions as a result
		// so we need to ignore the fact that it's missing
		// @ts-ignore
		ssr: {
			...user_config.ssr,
			// note to self: this _might_ need to be ['svelte', '@sveltejs/kit', ...get_no_external()]
			// but I'm honestly not sure. roll with this for now and see if it's ok
			noExternal: get_no_external(cwd, user_config.ssr && user_config.ssr.noExternal)
		},
		optimizeDeps: {
			entries: []
		}
	});
}

/**
 * @param {{
 *   cwd: string;
 *   base: string;
 *   config: import('types/config').ValidatedConfig
 *   manifest: import('types/internal').ManifestData
 *   build_dir: string;
 *   output_dir: string;
 *   client_entry_file: string;
 *   service_worker_entry_file: string;
 * }} options
 * @param {ClientManifest} client_manifest
 */
async function build_service_worker(
	{ cwd, base, config, manifest, build_dir, output_dir, service_worker_entry_file },
	client_manifest
) {
	// TODO add any assets referenced in template .html file, e.g. favicon?
	const app_files = new Set();
	for (const key in client_manifest) {
		const { file, css } = client_manifest[key];
		app_files.add(file);
		if (css) {
			css.forEach((file) => {
				app_files.add(file);
			});
		}
	}

	fs.writeFileSync(
		`${build_dir}/runtime/service-worker.js`,
		`
			export const timestamp = ${Date.now()};

			export const build = [
				${Array.from(app_files)
					.map((file) => `${s(`${config.kit.paths.base}/${config.kit.appDir}/${file}`)}`)
					.join(',\n\t\t\t\t')}
			];

			export const files = [
				${manifest.assets
					.map((asset) => `${s(`${config.kit.paths.base}/${asset.file}`)}`)
					.join(',\n\t\t\t\t')}
			];
		`
			.replace(/^\t{3}/gm, '')
			.trim()
	);

	/** @type {any} */
	const user_config = config.kit.vite();

	await vite.build({
		...user_config,
		configFile: false,
		root: cwd,
		base,
		build: {
			...user_config.build,
			lib: {
				entry: service_worker_entry_file,
				name: 'app',
				formats: ['es']
			},
			rollupOptions: {
				...(user_config.build && user_config.build.rollupOptions),
				output: {
					entryFileNames: 'service-worker.js'
				}
			},
			outDir: `${output_dir}/client`,
			emptyOutDir: false
		},
		resolve: {
			...user_config.resolve,
			alias: {
				...(user_config.resolve && user_config.resolve.alias),
				'$service-worker': path.resolve(`${build_dir}/runtime/service-worker`)
			}
		},
		optimizeDeps: {
			entries: []
		}
	});
}

/** @param {string[]} array */
function get_params(array) {
	// given an array of params like `['x', 'y', 'z']` for
	// src/routes/[x]/[y]/[z]/svelte, create a function
	// that turns a RexExpMatchArray into ({ x, y, z })
	return array.length
		? '(m) => ({ ' +
				array
					.map((param, i) => {
						return param.startsWith('...')
							? `${param.slice(3)}: d(m[${i + 1}] || '')`
							: `${param}: d(m[${i + 1}])`;
					})
					.join(', ') +
				'})'
		: 'empty';
}
