import express from "express";
import {
  processAsins,
  populateUkDbFields,
  populateUsDbFields,
} from "./server/utils";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Server is running");
});

(async () => {
  // // The below populates us & uk database fields
  // await processAsins();
  await populateUkDbFields();


  
})();

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
