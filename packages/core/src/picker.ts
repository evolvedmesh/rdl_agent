/**
 * The native file chooser.
 *
 * GPUIX has no file dialog of its own, so a path used to be something the user typed.
 * Rather than build a file browser inside the app, this delegates to the chooser the
 * desktop already has — Finder's on macOS, the common dialog on Windows, and whichever
 * portal-backed helper is installed on Linux — so recent places, bookmarks and typeahead
 * all come for free.
 *
 * It runs in the core process, not the shell: the UI holds no domain logic, and the
 * dialog belongs on the machine core runs on. Typing a path stays supported everywhere,
 * which is the fallback when no chooser can be found.
 *
 *   RDLA_FAKE_PICKER=/abs/path.rdl   answer with that path, spawn nothing
 *   RDLA_FAKE_PICKER=cancel          answer as if the user dismissed the dialog
 *   RDLA_FAKE_PICKER=none            answer as if no chooser is installed
 */

export type PickRequest = {
	/** Where to open the dialog. Ignored when it does not exist. */
	startDir?: string;
	title?: string;
};

export type PickResult =
	| { ok: true; path: string }
	/** The user dismissed the dialog — an outcome, not a failure. */
	| { ok: false; cancelled: true }
	| { ok: false; cancelled?: false; message: string };

export type PickerCommand = { argv: string[]; env: Record<string, string> };

/** The layouts this app can bind: an RDLC definition or a Word layout. */
const FILTER_EXTENSIONS = ["rdl", "rdlc", "docx"];

const DEFAULT_TITLE = "Select a report layout";

/**
 * The AppleScript and PowerShell programs are constants, and everything variable about
 * them arrives through the environment. That is deliberate: a directory name with a
 * quote in it would otherwise be code in two languages at once.
 */
const START_DIR_VAR = "RDLA_PICK_START";
const TITLE_VAR = "RDLA_PICK_TITLE";

const APPLESCRIPT = [
	`set startDir to (system attribute "${START_DIR_VAR}")`,
	`set dialogTitle to (system attribute "${TITLE_VAR}")`,
	// No type filter: .rdl has no registered UTI, and naming an unknown one fails the
	// whole dialog rather than showing everything.
	'if startDir is "" then',
	"  set chosen to choose file with prompt dialogTitle",
	"else",
	"  set chosen to choose file with prompt dialogTitle default location (POSIX file startDir)",
	"end if",
	"POSIX path of chosen",
];

const POWERSHELL = [
	"Add-Type -AssemblyName System.Windows.Forms",
	"$dialog = New-Object System.Windows.Forms.OpenFileDialog",
	`$dialog.Filter = 'Report layouts (${FILTER_EXTENSIONS.map((e) => `*.${e}`).join(";")})|${FILTER_EXTENSIONS.map((e) => `*.${e}`).join(";")}|All files (*.*)|*.*'`,
	`$dialog.Title = $env:${TITLE_VAR}`,
	`if ($env:${START_DIR_VAR}) { $dialog.InitialDirectory = $env:${START_DIR_VAR} }`,
	"if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }",
].join("; ");

/**
 * The argv for this platform's chooser, or null when none is installed.
 *
 * Separated from running it so the command for every platform can be asserted from any
 * platform — this is the part that cannot be exercised in CI by opening a dialog.
 */
export function pickerCommand(opts: {
	platform: string;
	which: (bin: string) => string | null;
	startDir?: string;
	title?: string;
}): PickerCommand | null {
	const title = opts.title ?? DEFAULT_TITLE;
	const env = {
		[TITLE_VAR]: title,
		...(opts.startDir ? { [START_DIR_VAR]: opts.startDir } : {}),
	};

	if (opts.platform === "darwin") {
		if (!opts.which("osascript")) return null;
		return {
			argv: ["osascript", ...APPLESCRIPT.flatMap((line) => ["-e", line])],
			env,
		};
	}

	if (opts.platform === "win32") {
		// Windows PowerShell needs -STA for a Forms dialog; pwsh is already STA on Windows.
		if (opts.which("powershell")) {
			return {
				argv: ["powershell", "-NoProfile", "-STA", "-Command", POWERSHELL],
				env,
			};
		}
		if (opts.which("pwsh")) {
			return { argv: ["pwsh", "-NoProfile", "-Command", POWERSHELL], env };
		}
		return null;
	}

	// Linux and the BSDs: whichever portal-backed helper the desktop shipped. zenity and
	// its forks share a flag set; kdialog has its own.
	const patterns = FILTER_EXTENSIONS.map((e) => `*.${e}`).join(" ");
	for (const bin of ["zenity", "qarma", "yad"]) {
		if (!opts.which(bin)) continue;
		const argv = [
			bin,
			"--file-selection",
			`--title=${title}`,
			`--file-filter=Report layouts | ${patterns}`,
			"--file-filter=All files | *",
		];
		// zenity takes the start directory as a filename; the trailing separator is what
		// makes it open *in* the directory rather than preselecting it as a file.
		if (opts.startDir)
			argv.push(`--filename=${opts.startDir.replace(/\/*$/, "/")}`);
		return { argv, env };
	}

	if (opts.which("kdialog")) {
		return {
			argv: [
				"kdialog",
				"--title",
				title,
				"--getopenfilename",
				opts.startDir ?? ".",
				`${patterns}|Report layouts`,
			],
			env,
		};
	}

	return null;
}

/** Cancelling is the one "failure" every chooser reports differently. */
function looksCancelled(stderr: string): boolean {
	return /user canceled|user cancelled|-128/i.test(stderr);
}

/**
 * Toolkit noise is not a failure.
 *
 * A GTK or Qt chooser routinely writes warnings — a stale settings.ini key, a missing
 * theme engine, an EGL probe — and then exits normally. Reporting those as the reason a
 * pick failed puts a wall of irrelevant text in front of someone who simply pressed
 * Escape, which is exactly what the first run of this did.
 */
function meaningfulStderr(stderr: string): string {
	return stderr
		.split("\n")
		.filter((line) => line.trim() !== "")
		.filter(
			(line) =>
				!/\b(WARNING|CRITICAL|DEBUG|Gtk-|Gdk-|GLib-|Qt:|qt\.|libEGL|libGL|deprecat)/i.test(
					line,
				),
		)
		.join("\n")
		.trim();
}

function firstLine(s: string): string {
	return (s.trim().split("\n")[0] ?? "").slice(0, 300);
}

/**
 * Open the chooser and wait for it.
 *
 * There is no timeout — a dialog is open for as long as the person needs — so the
 * caller has to be willing to wait, and to treat a dropped request as "type the path
 * instead" rather than as a broken picker.
 */
export async function pickFile(req: PickRequest = {}): Promise<PickResult> {
	const fake = process.env.RDLA_FAKE_PICKER;
	if (fake === "cancel") return { ok: false, cancelled: true };
	if (fake === "none") return { ok: false, message: noChooserMessage() };
	if (fake) return await resolvePicked(fake);

	const startDir =
		req.startDir && (await isDirectory(req.startDir))
			? req.startDir
			: undefined;
	const command = pickerCommand({
		platform: process.platform,
		which: (bin) => Bun.which(bin),
		startDir,
		title: req.title,
	});
	if (!command) return { ok: false, message: noChooserMessage() };

	let proc: { stdout: string; stderr: string; exitCode: number };
	try {
		const spawned = Bun.spawn(command.argv, {
			env: { ...process.env, ...command.env },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(spawned.stdout).text(),
			new Response(spawned.stderr).text(),
			spawned.exited,
		]);
		proc = { stdout, stderr, exitCode };
	} catch (e) {
		return {
			ok: false,
			message: `Could not start ${command.argv[0]}: ${e instanceof Error ? e.message : String(e)}`,
		};
	}

	const verdict = classifyPickOutput(command.argv[0] ?? "file chooser", proc);
	if (verdict.kind === "picked") return await resolvePicked(verdict.path);
	if (verdict.kind === "cancelled") return { ok: false, cancelled: true };
	return { ok: false, message: verdict.message };
}

export type PickVerdict =
	| { kind: "picked"; path: string }
	| { kind: "cancelled" }
	| { kind: "failed"; message: string };

/**
 * What a chooser's exit means. Exported because it is the part that gets this wrong:
 * the first version of this called a GTK warning a failure and put it in front of
 * someone who had simply pressed Escape.
 */
export function classifyPickOutput(
	bin: string,
	proc: { stdout: string; stderr: string; exitCode: number },
): PickVerdict {
	const picked = proc.stdout.trim();
	if (picked) return { kind: "picked", path: picked };

	// A clean exit with nothing chosen is how the Windows dialog reports Cancel.
	if (proc.exitCode === 0) return { kind: "cancelled" };

	// Otherwise: dismissed, or the chooser itself failed — a missing display, say. Only
	// the second is worth showing, and only what is left of stderr once the toolkit has
	// finished complaining about the user's theme.
	const failure = meaningfulStderr(proc.stderr);
	if (failure === "" || looksCancelled(failure)) return { kind: "cancelled" };
	return { kind: "failed", message: `${bin}: ${firstLine(failure)}` };
}

/** A chooser can hand back a path that is gone, or a directory. Say so plainly. */
async function resolvePicked(path: string): Promise<PickResult> {
	const trimmed = path.trim();
	if (!(await Bun.file(trimmed).exists())) {
		return { ok: false, message: `The chosen path does not exist: ${trimmed}` };
	}
	return { ok: true, path: trimmed };
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		const { stat } = await import("node:fs/promises");
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

function noChooserMessage(): string {
	if (process.platform === "linux") {
		return "No file chooser found. Install zenity or kdialog, or type the path.";
	}
	return "No file chooser is available on this system. Type the path instead.";
}
