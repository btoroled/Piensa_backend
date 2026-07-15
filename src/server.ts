import { buildApp } from "./app.js";
import { EnvValidationError, loadEnv } from "./config/env.js";

let env;
try {
  env = loadEnv();
} catch (err) {
  if (err instanceof EnvValidationError) {
    // Mensaje claro para el operador; nunca un stack trace.
    process.stderr.write(`[config] ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const app = buildApp({ logger: true, jwtSecret: env.JWT_SECRET });

app
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .then((address) => {
    app.log.info(`Piensa backend escuchando en ${address}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
