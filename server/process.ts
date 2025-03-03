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
    const response = await axios.get("https://api.keepa.com/product", {
      params: {
        key: process.env.KEEPA_API_KEY,
        domain: domain, // Dynamically setting domain
        asin: asins.join(","),
        buybox: 1,
        // stats: 30,
        stats:7,
      },
    });

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
  const concurrentBatches = 10; // Number of concurrent requests
  const maxRetries = 2;
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
            try {
              const tokensLeftBefore = await checkTokenAmount();
              console.log(`Tokens Left Before: ${tokensLeftBefore}`);

              const keepaData = await fetchKeepaData(currentBatch, 1);
              if (!keepaData || !Array.isArray(keepaData.products)) {
                console.error("No valid data received from Keepa.");
                return;
              }

              // Filter and process data
              const ukKeepaData = keepaData.products.filter((item) => item.domainId === 2);
              const usKeepaData = keepaData.products.filter((item) => item.domainId === 1);
              const usDataMap = new Map(usKeepaData.map((item) => [item.asin, item]));

              const processedKeepaEntries = ukKeepaData.map((ukItem) => {
                if (!ukItem.title || ukItem.title.length === 0) {
                  return { asin: ukItem.asin, exists: false };
                }

                const usItem = usDataMap.get(ukItem.asin);
                const ukAvailableOnAmazon = ukItem.availabilityAmazon !== null && ukItem.availabilityAmazon >= 0;
                let ukAmazonCurrent = ukItem.stats?.buyBoxIsAmazon ? ukItem.stats?.buyBoxPrice : ukItem.csv[0]?.[ukItem.csv[0].length - 1];

                return {
                  asin: ukItem.asin,
                  exists: true,
                  ukPackageWeight: ukItem.packageWeight,
                  ukBuyBoxPrice: ukItem.stats?.buyBoxPrice,
                  ukAvailableOnAmazon,
                  ukAmazonCurrent,
                  usBsrDrop: usItem?.stats?.salesRankDrops30,
                  usBuyBoxPrice: usItem?.stats?.buyBoxPrice,
                  usFbaFee: usItem?.fbaFees?.pickAndPackFee,
                  usReferralFee: usItem?.referralFeePercent,
                  usAvgBb90Day: usItem?.stats?.avg90?.[18],
                  usAvgBb360Day: usItem?.stats?.avg365?.[18],
                };
              });

              // Log tokens used after API call
              const tokensLeftAfter = await checkTokenAmount();
              const tokensUsedForBatch = tokensLeftBefore - tokensLeftAfter;
              console.log(`Tokens Used for Batch ${batchIndex + 1}: ${tokensUsedForBatch}`);
              tokensUsed += tokensUsedForBatch;

              processed = true;

              // Using Prisma transaction to bulk update records
              await prisma.$transaction(
                processedKeepaEntries.map((entry) => {
                  return prisma.final_UK_USA_5M_common.update({
                    where: { ASIN: entry.asin },
                    data: entry.exists
                      ? {
                          ukPackageWeight: entry.ukPackageWeight,
                          ukBuyBoxPrice: entry.ukBuyBoxPrice,
                          ukAvailableOnAmazon: entry.ukAvailableOnAmazon,
                          ukAmazonCurrent: entry.ukAmazonCurrent,
                          usBsrDrop: entry.usBsrDrop,
                          usBuyBoxPrice: entry.usBuyBoxPrice,
                          usFbaFee: entry.usFbaFee,
                          usReferralFee: entry.usReferralFee,
                          usAvgBb90Day: entry.usAvgBb90Day,
                          usAvgBb360Day: entry.usAvgBb360Day,
                          hasBeenProcessed: true,
                          existsInUk: true,
                        }
                      : {
                          hasBeenProcessed: true,
                          existsInUk: false,
                        },
                  });
                })
              );
            } catch (error) {
              console.error(`Error processing batch ${batchIndex + 1}:`, error);
              retryCount++;
              if (retryCount < maxRetries) {
                console.log(`Retrying in ${retryDelay / 1000} seconds...`);
                await new Promise((resolve) => setTimeout(resolve, retryDelay));
              }
            }
          }
        })()
      );
    }

    await Promise.all(batchPromises);
    console.log(`Total Tokens Used: ${tokensUsed}`);
  }
};
