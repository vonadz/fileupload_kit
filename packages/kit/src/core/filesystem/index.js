import fs from 'fs';
import path from 'path';

/** @param {string} dir */
export function mkdirp(dir) {
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch (e) {
		if (e.code === 'EEXIST') return;
		throw e;
	}
}

/** @param {string} path */
export function rimraf(path) {
	(fs.rmSync || fs.rmdirSync)(path, { recursive: true, force: true });
}

/**
 * @param {string} from
 * @param {string} to
 * @param {(basename: string) => boolean} filter
 */
export function copy(from, to, filter = () => true) {
	if (!fs.existsSync(from)) return [];
	if (!filter(path.basename(from))) return [];

	const files = [];
	const stats = fs.statSync(from);

	if (stats.isDirectory()) {
		fs.readdirSync(from).forEach((file) => {
			files.push(...copy(path.join(from, file), path.join(to, file)));
		});
	} else {
		mkdirp(path.dirname(to));
		fs.copyFileSync(from, to);
		files.push(to);
	}

	return files;
}
