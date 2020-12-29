let os = require('os');
let fs = require('fs');
let path = require('path');
let child_process = require('child_process');
let string_decoder = require('string_decoder');

// Escape spaces in argument
function escapeArg(x)  
{
    if (os.platform() == "win32")
        return (x.indexOf(' ') >= 0 || x.indexOf('|') >= 0)? `"${x}"` : x;
    else
        return x.replace(/ /g, '\\ ');
}

// Parse an command line arguments from a string
// Enclose args with spaces in double quotes
function parseArgs(cmd)
{
    // Split command
    let args = [];
	let arg = "";
	let inQuote = false;
	for (let i=0; i<cmd.length; i++)
	{
		if (cmd[i] == '\"')
		{
			if (inQuote)
			{
				inQuote = false;
			}
			else
			{
				inQuote = true;
			}
			continue;
		}

		if (!inQuote && cmd[i] == ' ' || cmd[i] == '\t')
		{
			if (arg.length > 0)
			{
				args.push(arg);
				arg = "";
			}
		}
		else
		{
			arg += cmd[i];
		}
	}

	if (arg.length > 0)
		args.push(arg);

	return args;
}

// Synchronously prompt for input
function prompt(message)
{
    // Write message
    process.stdout.write(message);

    // Work out shell command to prompt for a string and echo it to stdout
    let cmd;
    let args;
    if (os.platform() == "win32")
    {
        cmd = 'cmd';
        args = [ '/V:ON', '/C', 'set /p response= && echo !response!' ];
    }
    else
    {
        cmd = 'bash';
        args = [ '-c', 'read response; echo "$response"' ];
    }

    // Pipe stdout back to self so we can read the echoed value
    let opts = { 
        stdio: [ 'inherit', 'pipe', 'inherit' ],
        shell: false,
    };

    // Run it
    return child_process.spawnSync(cmd, args, opts).stdout.toString().trim();
}

// pushd/popd stack
let pushd_stack = [];

function cd(dir)
{
    process.chdir(dir);
    return { status: 0 }; 
}

function pushd(dir)
{
    pushd_stack.push(process.cwd());
    process.chdir(dir);
    return { status: 0 }; 
}

function popd()
{
    if (pushd_stack.length >= 0)
        process.chdir(pushd_stack.pop())
    return { status: 0 }; 
}

function readFileJSON(filename, encoding)
{
    return JSON.parse(fs.readFileSync(filename, encoding));
}

// Synchronously read the content of a text file one line at a time
// Note, caller must complete the iteration for file to be closed
//        ie: don't break out early from the loop calling this function
function* readFileLines(filename, encoding)
{
    let fd = fs.openSync(filename);
    let buf = Buffer.allocUnsafe(32768);
    let pos = 0;
    let decoder = new string_decoder.StringDecoder(encoding || 'UTF8');
    let lineStart = "";

    while (true)
    {
        // Read buffer
        let bytesRead = fs.readSync(fd, buf, 0, buf.length, pos);
        pos += bytesRead;

        // Decode string
        let str;
        if (bytesRead < buf.length)
            str = lineStart + decoder.end(buf.subarray(0, bytesRead));
        else
            str = lineStart + decoder.write(buf);

        // Split into lines and yield the complete ones
        let lines = str.split(/\r?\n/);
        for (let i=0; i<lines.length - 1; i++)
        {
            yield lines[i];
        }

        // The last line is the start of the first line in the next chunk
        lineStart = lines[lines.length - 1];

        // quit if eof
        if (bytesRead < buf.length)
            break;
    }

    // Final line
    yield lineStart;
        
    fs.closeSync(fd);
}

// Invoke a command
function shell_args(cmd, args, opts)
{
    // Handle missing params
	if (!args)
        args = [];
    if (!opts)
        opts = {};

    // Suppress echo by @ prefix?
    let noEcho = false;
    while (true)
    {
        if (cmd.startsWith('<'))
        {
            // Capture output shortcut?
            opts.capture = true;
            cmd = cmd.substr(1);
        }
        else if (cmd.startsWith('@'))
        {
            // Suppress echo
            noEcho = true;
            cmd = cmd.substr(1);
        }
        else if (cmd.startsWith('-'))
        {
            // Ignore errors shortcut
            opts.ignoreErrors = true;
            cmd = cmd.substr(1);
        }
        else
            break;
    }

    // Resolve full environment
    let env = Object.assign({}, process.env);
    if (shell.opts.env)
        env = Object.assign(env, shell.opts.env);
    if (opts.env)
        env = Object.assign(env, opts.env);

    // Resolve options
    opts = Object.assign({
        stdio: ['inherit', opts.capture ? 'pipe' : 'inherit', 'inherit'],
        shell: true,
    }, shell.opts, opts);

    // Resolve environment
    opts.env = env;
    
    // Echo the command
    if ((opts.echo && !noEcho) || opts.debug)
    {
        let cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
        if (opts.debug)
        {
            console.log(`DEBUG: cmd: ${cmd}`);
            console.log(`       cwd: ${cwd}`);
            console.log(`      args:`, args);
            console.log(`      opts:`, opts);
        }
        else
        {
            console.log(`${cwd}$ ${escapeArg(cmd)} ${args.map(escapeArg).join(" ")}`);
        }
    }

    // Special commands
    switch (cmd)
    {
        case "cd":
            if (args.length != 1)
                throw new Error("cd expects 1 argument");
            return cd(args[0]);

        case "pushd":
            if (args.length != 1)
                throw new Error("pushd expects 1 argument");
            return pushd(args[0]);

        case "popd":
            if (args.length != 0)
                throw new Error("popd expects 0 argument");
            return popd();
    }

    // Hack for node not quoting args with spaces when shell
    // option enabled.
    if (os.platform() == "win32" && opts.shell === true)
    {
        args.unshift(cmd);
        args.unshift("/c");
        cmd = process.env.ComSpec || "cmd.exe";
        opts.shell = false;
    }

    // Run it
    let result = child_process.spawnSync(cmd, args, opts);

    // Store result on shell object
    shell.result = result;

    // Failed to launch
    if (!opts.ignoreErrors)
    {
        if (result.error)
        {
            throw new Error(`${escapeArg(cmd)} ${args.map(escapeArg).join(" ")} failed - ${result.error.message}`);
        }

        // Failed exit code?
        if (result.status != 0)
        {
            throw new Error(`${escapeArg(cmd)} ${args.map(escapeArg).join(" ")} failed with exit code ${result.status}`);
        }
    }

    if (opts.capture)
        return result.stdout.toString().trim();

    // Return result
    return result;
}

function shell()
{
	// Parse args
    let args = [];
    let opts = {};
	for (let i = 0; i < arguments.length; i++) 
	{
        if (Array.isArray(arguments[i]))
        {
            args = args.concat(arguments[i]);
        }
        else if (typeof(arguments[i]) === "object")
        {
            if (i == arguments.length - 1)
                opts = arguments[i];
            else
                throw new Error("Options must be passed to shell() as last argument");
        }
        else if (typeof(arguments[i]) === "string")
        {
            args = args.concat(parseArgs(arguments[i]));
        }
        else
            throw new Error(`Unknown argument type '${typeof(arguments[i])}' passed to shell()`);
    }
    
	// First arg is the command
	let cmd = args.shift();

	// run_args the command
	return shell_args(cmd, args, opts);
}

shell.opts = { env: {} };
shell.prompt = prompt;
shell.cd = cd;
shell.pushd = pushd;
shell.popd = popd;
shell.exists = fs.existsSync;
shell.readFile = fs.readFileSync;
shell.readFileLines = readFileLines;
shell.readFileJSON = readFileJSON;

module.exports = shell;
