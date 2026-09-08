/** Vite side-effect imports and the Electrobun SDK, which Hutch projects at build time. */

declare module "*.css";

declare module "electrobun" {
	export type ElectrobunConfig = {
		app: {
			name: string;
			identifier: string;
			version: string;
			description?: string;
		};
		build?: Record<string, unknown>;
		runtime?: Record<string, unknown>;
		release?: Record<string, unknown>;
		scripts?: Record<string, string>;
	};
}

declare module "electrobun/main" {
	export class BrowserWindow {
		constructor(opts: {
			title?: string;
			url: string;
			html?: string;
			frame?: { width: number; height: number; x?: number; y?: number };
			rpc?: unknown;
		});
		close(): void;
	}
}
