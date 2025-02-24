import express from "express";
import {
  populateUkDbFields,
  populateUsDbFields,
  processAsins,
} from "./server/utils";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Server is running");
});

(async () => {
  // // The below populates us & uk database fields
  // await processAsins();

  // The below populates uk database fields
  await populateUkDbFields();

  // // The below populates us database fields
  // await populateUsDbFields();

  // If we want to run all 3 functions at the same time, we can do so by running promise.all
  // await Promise.all([processAsins(), populateUkDbFields(), populateUsDbFields()]);
})();

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
