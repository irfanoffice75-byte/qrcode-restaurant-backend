module.exports = {
  apps: [{
    name: "qr-backend",
    script: "./server.js",
    instances: "max", // This will spawn as many processes as there are CPU cores
    exec_mode: "cluster",
    watch: false,
    env: {
      NODE_ENV: "development",
    },
    env_production: {
      NODE_ENV: "production",
    }
  }]
}
