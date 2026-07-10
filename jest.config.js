/** @type {import('jest').Config} */
module.exports = {
	testEnvironment: 'node',
	transform: {
		'^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
	},
	testMatch: ['**/tests/**/*.test.ts'],
};
