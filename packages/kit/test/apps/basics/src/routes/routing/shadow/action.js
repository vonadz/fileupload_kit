let random = 0;

/** @type {import('@sveltejs/kit').RequestHandler} */
export function post({ body }) {
	// @ts-ignore (TODO make the types work somehow)
	random = body.get('random');
}

export function get() {
	return {
		body: {
			random
		}
	};
}
