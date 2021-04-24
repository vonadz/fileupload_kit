const cfw = require('@sveltejs/adapter-cloudflare-workers');

module.exports = {
	kit: {
		adapter: cfw(),
		target: '#svelte'
	}
};
