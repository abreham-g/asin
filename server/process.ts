import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
config(); // Load .env file

const prisma = new PrismaClient();
let tokensUsed = 0;

export async function checkTokenAmount(): Promise<number> {
  try {
    const apiKey = process.env.KEEPA_API_KEY;
    if (!apiKey) {
      throw new Error("KEEPA_API_KEY not found in environment variables");
    }

    const response = await axios.get(`https://api.keepa.com/token?key=${apiKey}`);
    return response.data.tokensLeft || 0;
  } catch (error) {
    console.log(`Failed to check token amount: ${error}`);
    return 0;
  }
}

export const tokenMultiplierBasedOnParams = 3;
export async function fetchKeepaData(asins: string[], domain: number): Promise<any> {
  try {
    console.log(`Fetching data for ASINs: ${asins.length}, Domain: ${domain}`);
    
    const response = await axios.get("https://api.keepa.com/product", {
      params: {
        key: process.env.KEEPA_API_KEY,
        domain: domain, // Dynamically setting domain
        asin: asins.join(","),
        buybox: 1,
        stats: 30,
      },
    });
    
    console.log("Received data from Keepa API");
    return response.data;
  } catch (error) {
    console.error("Error fetching Keepa data:", error);
    return null;
  }
}

export async function fetchUnprocessedAsins() {
  return await prisma.final_UK_USA_5M_common.findMany({
    where: {
      hasBeenProcessedUk: false,
      hasBeenProcessedUs: false,
    },
    take: 500000,
  });
}

export const processAsins = async () => {
  console.log("Running scheduled job");
  const asinsData = await fetchUnprocessedAsins();
  if (!asinsData || asinsData.length === 0) {
    console.log("No data to process");
    return;
  }

  const batchSize = 100; // Keepa's limit
  const concurrentBatches = 10;
  const maxRetries = 5;
  const retryDelay = 5 * 60 * 1000; // 5 minutes
  const totalBatches = Math.ceil(asinsData.length / batchSize);

  console.log(`Starting to process ${asinsData.length} ASINs in ${totalBatches} batches`);

  for (let groupIndex = 0; groupIndex < totalBatches; groupIndex += concurrentBatches) {
    const batchPromises = [];

    for (let i = 0; i < concurrentBatches && groupIndex + i < totalBatches; i++) {
      const batchIndex = groupIndex + i;
      const start = batchIndex * batchSize;
      const end = Math.min(start + batchSize, asinsData.length);
      const currentBatch = asinsData.slice(start, end).map((item) => item.ASIN);

      batchPromises.push(
        (async () => {
          let retryCount = 0;
          let processed = false;

          console.log(`Processing batch ${batchIndex + 1}/${totalBatches}`);

          while (!processed && retryCount < maxRetries) {
            const tokensLeft = await checkTokenAmount();
            const requiredTokens = tokenMultiplierBasedOnParams * currentBatch.length * 2;
            const tokensBefore = tokensUsed;

            console.log(`Batch ${batchIndex + 1}/${totalBatches}: Tokens Required: ${requiredTokens}, Tokens Left: ${tokensLeft}`);

            if (tokensLeft < requiredTokens) {
              retryCount++;
              console.log(`Batch ${batchIndex + 1}/${totalBatches}: Insufficient tokens. Waiting ${retryDelay / 1000 / 60} minutes before retry ${retryCount}/${maxRetries}`);
              await new Promise((resolve) => setTimeout(resolve, retryDelay));
              continue;
            }

            try {
              const keepaData = await fetchKeepaData(currentBatch, 1);
              if (!keepaData || !Array.isArray(keepaData.products)) {
                console.error("No valid data received from Keepa.");
                return;
              }

              console.log(`Batch ${batchIndex + 1} processed successfully`);
              processed = true;
              tokensUsed += requiredTokens;
              console.log(`Tokens Before: ${tokensBefore}, Tokens Added: ${requiredTokens}, Tokens After: ${tokensUsed}`);

            } catch (error) {
              console.error(`Error processing batch ${batchIndex + 1}:`, error);
              retryCount++;
              await new Promise((resolve) => setTimeout(resolve, 30000));
            }
          }
        })()
      );
    }

    await Promise.all(batchPromises);
    console.log(`Total Tokens Used: ${tokensUsed}`);
    if ((groupIndex + concurrentBatches) % 1000 === 0) {
      console.log(`Milestone: Processed ${groupIndex + concurrentBatches} batches`);
    }
  }
};
