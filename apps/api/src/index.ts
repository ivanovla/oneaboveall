import { buildServer } from "./server";

const app = buildServer();
const port = Number(process.env.PORT ?? 3001);

app.listen({ port, host: "127.0.0.1" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
