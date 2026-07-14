import { buildApp } from "./app.js";

const app = buildApp({ logger: true });
const port = Number(process.env.PORT ?? 3000);

app
  .listen({ port, host: "0.0.0.0" })
  .then((address) => {
    app.log.info(`Piensa backend escuchando en ${address}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
