/** @type {import('@sveltejs/kit').RequestHandler} */
export function get(request) {
	return {
		body: {
			name: request.context.name
		}
	};
}
