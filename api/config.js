function getConfig() {
  const url = process.env.DEEPSEEK_URL || "https://api.deepseek.com/v1";
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  return { provider: "deepseek", url, model, mode: "proxy" };
}

module.exports = (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = 200;
  res.end(JSON.stringify(getConfig()));
};

