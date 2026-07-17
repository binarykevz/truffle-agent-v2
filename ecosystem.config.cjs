module.exports = {
    apps: [
        {
            name: "truffle-agent",
            script: "src/index.ts",
            interpreter: "bun",
            interpreterArgs: "run",
            cwd: "/home/kevz/truffle-agent-v2", // 👈 UPDATE THIS
            env: { NODE_ENV: "production" },
            autorestart: true,
            watch: false,
            max_restarts: 10,
            restart_delay: 4000,
            max_memory_restart: "512M",
            error_file: "./logs/error.log",
            out_file: "./logs/output.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
            merge_logs: true,
            kill_timeout: 5000,
        },
    ],
};
