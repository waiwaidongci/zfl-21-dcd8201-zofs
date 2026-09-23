const http = require("http");
const { ensureDb } = require("./src/store");
const { handle, routes } = require("./src/routes");

const PORT = Number(process.env.PORT || 3021);

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    res.writeHead(error.status || 500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message || "服务器错误" }, null, 2));
  });
});

ensureDb().then(() => {
  server.listen(PORT, () => {
    console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
    console.log(`Routes:\n${routes.map((route) => `  ${route}`).join("\n")}`);
  });
});
