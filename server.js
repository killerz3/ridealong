// agent-browser: one persistent Chrome you drive from a web page and bots
// drive over CDP, each bot confined to its own tabs.
const chrome = process.env.AB_CHROME || 'http://127.0.0.1:9222';
const password = process.env.AB_PASSWORD;
if (!password) { console.error('set AB_PASSWORD'); process.exit(1); }
require('./viewer').start({ port: +(process.env.AB_VIEW_PORT || 8083), chrome, password });
require('./botproxy').start({ port: +(process.env.AB_BOT_PORT || 9230), chrome });
