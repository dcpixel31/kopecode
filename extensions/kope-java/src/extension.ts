import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as cp from 'child_process';
import {
	LanguageClient, LanguageClientOptions, ServerOptions, CloseAction,
	ErrorAction
} from 'vscode-languageclient/node';

let client: LanguageClient;
const MIN_JAVA_VERSION = 17;
const MAX_JAVA_VERSION = 99; // Support all Java 17+

export async function activate(context: vscode.ExtensionContext) {
	console.log('KopeCode Java extension is activating...');

	try {
		const javaCmdPath = await findValidJavaRuntime(context);
		console.log(`✅ Using Java executable: ${javaCmdPath}`);
		await launchLanguageServer(context, javaCmdPath);
	} catch (error: any) {
		console.error('❌ Error during extension activation:', error.message);

		// Show a friendly pop-up with options
		const selection = await vscode.window.showErrorMessage(
			`❗️ Java not found or invalid.\n\nKopeCode requires a JDK (version ${MIN_JAVA_VERSION}–${MAX_JAVA_VERSION}) to run.\n\nFix this by installing a JDK and setting 'kope-java.javaHome' in your settings.`,
			'Download JDK',
			'Open Settings',
			'Dismiss'
		);

		if (selection === 'Download JDK') {
			vscode.env.openExternal(vscode.Uri.parse('https://adoptium.net/en-GB/temurin/releases/'));
		} else if (selection === 'Open Settings') {
			vscode.commands.executeCommand('workbench.action.openSettings', 'kope-java.javaHome');
		}
	}

	// Listen for configuration changes
	const configChangeListener = vscode.workspace.onDidChangeConfiguration(async (event) => {
		if (event.affectsConfiguration('kope-java.javaHome')) {
			console.log('🔄 kope-java.javaHome setting changed, restarting language server...');
			await restartLanguageServer(context);
		}
	});
	
	context.subscriptions.push(configChangeListener);
}


export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}

async function launchLanguageServer(context: vscode.ExtensionContext, javaCmdPath: string) {
	console.log('🚀 Launching Java Language Server...');

	const serverDataPath = path.join(context.extensionPath, 'server-data');
	console.log(`📁 Using server data path: ${serverDataPath}`);
	if (!fs.existsSync(serverDataPath)) {
		fs.mkdirSync(serverDataPath);
	}

	const serverJarPath = path.join(context.extensionPath, 'server', 'jdt-language-server.jar');
	console.log(`🔍 Looking for Java Language Server JAR at: ${serverJarPath}`);
	if (!fs.existsSync(serverJarPath)) {
		throw new Error(
			`Java Language Server jar not found at: ${serverJarPath}.\n` +
			`Please reinstall the KopeCode Java extension.`
		);
	}

	// Server process options
	const serverOptions: ServerOptions = {
		command: javaCmdPath,
		args: [
			'-jar',
			serverJarPath,
			'-configuration',
			path.join(context.extensionPath, 'server', 'config_win'),
			'-data',
			serverDataPath
		]
	};

	// Language client options
	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'java' }],
		errorHandler: {
			error: (error, message, count) => {
				console.error(`❌ Language server error (attempt ${count}):`, error);
				if (typeof count === 'number' && count <= 3) {
					vscode.window.showErrorMessage(
						`KopeCode Java Language Server error: ${error.message || 'Unknown error'}`
					);
				}
				return { action: ErrorAction.Shutdown };
			},
			closed: () => {
				console.warn('⚠️ Java Language Server connection closed.');
				vscode.window.showErrorMessage(
					'Java Language Server connection closed unexpectedly. Please check your Java setup.'
				);
				return { action: CloseAction.DoNotRestart };
			}
		}
	};

	// Create and store the client globally
	client = new LanguageClient(
		'kopeJavaLanguageServer',
		'KopeCode Java Language Server',
		serverOptions,
		clientOptions
	);

	console.log('🧠 Starting the Java Language Server client...');

	try {
		// Attempt to start the client (this launches the Java process)
		await client.start();
		console.log('✅ Java Language Server client started.');

		// Optionally surface output and warn user to check Output panel
		setTimeout(() => {
			console.log('[KopeJava] Java Language Server started.');
			console.log('[KopeJava] If no further output appears, check your Java path.');
			client.outputChannel.show(true); // Automatically open the Output tab
			vscode.window.showWarningMessage(
				'Java Language Server launched. If it doesn’t respond, check the Output panel for logs.'
			);
		}, 1500);
	} catch (error: any) {
		// Catch startup failures — like invalid Java path or spawn error
		console.error('❌ Failed to start Java Language Server:', error);

		let errorMessage = 'Failed to start Java Language Server. ';
		if (error.message?.includes('ENOENT')) {
			errorMessage += 'Java executable not found. Please verify the configured path.';
		} else if (error.message?.includes('spawn')) {
			errorMessage += 'Could not spawn Java process. Ensure it’s a valid executable.';
		} else {
			errorMessage += error.message || 'Unknown error.';
		}

		vscode.window.showErrorMessage(errorMessage);
		throw new Error(errorMessage);
	}
}



async function findValidJavaRuntime(context: vscode.ExtensionContext): Promise<string> {
	console.log('🔍 Starting Java runtime discovery...');

	// 1. Check user configuration
	const config = vscode.workspace.getConfiguration('kope-java');
	const userPath = config.get<string>('javaHome');
	console.log(`⚙️ kope-java.javaHome setting: ${userPath}`);

	if (userPath) {
		const result = await validateJavaPath(userPath);
		if (result.isValid) {
			console.log(`✅ Valid Java found at user-configured path: ${result.path}`);
			return result.path;
		} else {
			console.warn(`❌ User-defined Java path is invalid: ${result.reason}`);
			throw new Error(`Invalid Java installation at '${userPath}'. ${result.reason}`);
		}
	}

	// 2. Check JAVA_HOME
	if (process.env.JAVA_HOME) {
		console.log(`🔧 Checking JAVA_HOME: ${process.env.JAVA_HOME}`);
		const result = await validateJavaPath(process.env.JAVA_HOME);
		if (result.isValid) {
			console.log(`✅ Valid Java found from JAVA_HOME: ${result.path}`);
			return result.path;
		} else {
			console.warn(`❌ JAVA_HOME is invalid: ${result.reason}`);
		}
	} else {
		console.log('📭 JAVA_HOME not set.');
	}

	// 3. Check PATH for java.exe
	try {
		console.log('🔎 Searching system PATH for java...');
		const { stdout } = await execPromise('where java');
		const javaPaths = stdout.trim().split('\r\n');

		for (const javaPath of javaPaths) {
			const jdkHome = path.dirname(path.dirname(javaPath));
			console.log(`🧪 Trying PATH java at: ${jdkHome}`);
			const result = await validateJavaPath(jdkHome);
			if (result.isValid) {
				console.log(`✅ Valid Java found in PATH: ${result.path}`);
				return result.path;
			}
		}
	} catch (e) {
		console.warn('⚠️ No java.exe found in system PATH.');
	}

	// 4. Nothing found
	console.error('❌ No valid Java installation found.');
	throw new Error(
		`KopeCode could not find a compatible Java Development Kit (JDK version ${MIN_JAVA_VERSION}-${MAX_JAVA_VERSION}) on your system.\n\n` +
		`Please:\n` +
		`1. Install a compatible JDK (Oracle JDK, OpenJDK, or Eclipse Temurin)\n` +
		`2. Set the JAVA_HOME environment variable, or\n` +
		`3. Configure the 'kope-java.javaHome' setting in VS Code`
	);
}

async function validateJavaPath(javaHomePath: string): Promise<{ isValid: true; path: string } | { isValid: false; reason: string }> {
	console.log(`🧪 Validating Java path: ${javaHomePath}`);

	if (!fs.existsSync(javaHomePath)) {
		console.warn(`❌ Path does not exist: ${javaHomePath}`);
		return { isValid: false, reason: "The specified directory does not exist." };
	}

	const javaExe = path.join(javaHomePath, 'bin', 'java.exe');
	if (!fs.existsSync(javaExe)) {
		console.warn(`❌ java.exe not found: ${javaExe}`);
		return { isValid: false, reason: `The file '${javaExe}' does not exist.` };
	}

	const javacExe = path.join(javaHomePath, 'bin', 'javac.exe');
	if (!fs.existsSync(javacExe)) {
		console.warn(`❌ javac.exe not found: ${javacExe}`);
		return { isValid: false, reason: "It is not a JDK (missing 'javac.exe')." };
	}

	try {
		const { stderr } = await execPromise(`"${javaExe}" -version`);
		const versionMatch = stderr.match(/"(\d+)\./);
		if (versionMatch && versionMatch[1]) {
			const majorVersion = parseInt(versionMatch[1], 10);
			console.log(`📋 Detected Java version: ${majorVersion}`);
			if (majorVersion >= MIN_JAVA_VERSION && majorVersion <= MAX_JAVA_VERSION) {
				return { isValid: true, path: javaExe };
			} else {
				return { isValid: false, reason: `Version ${majorVersion} is outside supported range (${MIN_JAVA_VERSION}-${MAX_JAVA_VERSION}).` };
			}
		} else {
			console.warn('⚠️ Could not parse Java version.');
			return { isValid: false, reason: "Could not determine Java version." };
		}
	} catch (error) {
		console.warn('❌ Failed to execute java -version');
		return { isValid: false, reason: "Could not execute 'java -version' successfully." };
	}
}

async function restartLanguageServer(context: vscode.ExtensionContext) {
	try {
		// Stop the current language server if running
		if (client) {
			console.log('🛑 Stopping current language server...');
			await client.stop();
			client = undefined as any;
		}

		// Try to start with new configuration
		const javaCmdPath = await findValidJavaRuntime(context);
		console.log(`✅ Using new Java executable: ${javaCmdPath}`);
		await launchLanguageServer(context, javaCmdPath);
		
		vscode.window.showInformationMessage('✅ Java Language Server restarted successfully!');
	} catch (error: any) {
		console.error('❌ Error restarting language server:', error.message);
		vscode.window.showErrorMessage(`❌ Failed to restart Java Language Server: ${error.message}`);
	}
}

function execPromise(command: string): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		cp.exec(command, (error, stdout, stderr) => {
			if (error) {
				console.warn(`⚠️ Command failed: ${command}`, error);
				reject(error);
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}
