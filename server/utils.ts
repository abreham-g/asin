import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
config(); // Load .env file

const prisma = new PrismaClient();

// based on the request params
export const tokenMultiplierBasedOnParams = 3;
export async function fetchKeepaData(
  asins: string[],
  domain: number
): Promise<any> {
  try {
    const response = await axios.get("https://api.keepa.com/product", {
      params: {
        key: process.env.KEEPA_API_KEY,
        domain,
        asin: asins.join(","),
        buybox: 1,
        stats: 30,
      },
    });

    return response.data;
  } catch (error) {
    console.error("Error fetching Keepa data:", error);
    return null;
  }
}

export async function fetchAsinsToPopulateUkDbFields() {
  try {
    const data = await prisma.sample_a2a.findMany({
      where: {
        hasBeenProcessed: false,
        hasBeenProcessedUk: false,
      },
      take: 500000,
    });
    console.log("Fetched data:", data.length);
    return data;
  } catch (error) {
    console.error("Error fetching data:", error);
  } finally {
    await prisma.$disconnect();
  }
}

export async function fetchAsinsToPopulateUsDbFields() {
  try {
    const data = await prisma.sample_a2a.findMany({
      where: {
        ukBuyBoxPrice: {
          gt: 0,
        },
        hasBeenProcessedUs: false,
        hasBeenProcessed: false,
      },
    });
    console.log("Fetched data:", data.length);
    return data;
  } catch (error) {
    console.error("Error fetching data:", error);
  } finally {
    await prisma.$disconnect();
  }
}

export async function checkTokenAmount(): Promise<number> {
  try {
    const apiKey = process.env.KEEPA_API_KEY;
    if (!apiKey) {
      throw new Error("KEEPA_API_KEY not found in environment variables");
    }

    const response = await axios.get(
      `https://api.keepa.com/token?key=${apiKey}`
    );
    return response.data.tokensLeft || 0;
  } catch (error) {
    console.log(`Failed to check token amount: ${error}`);
    return 0;
  }
}

export const populateUkDbFields = async () => {
  console.log("Running scheduled job");
  const asinsData = await fetchAsinsToPopulateUkDbFields();
  if (!asinsData) {
    console.log("No data to process");
    return;
  }

  const batchSize = 100; // Keepa's limit
  const concurrentBatches = 10; // Number of concurrent requests
  const maxRetries = 5;
  const retryDelay = 5 * 60 * 1000; // 10 minutes
  const totalBatches = Math.ceil(asinsData.length / batchSize);

  console.log(
    `Starting to process ${asinsData.length} ASINs in ${totalBatches} batches`
  );

  // Process batches in groups of concurrentBatches
  for (
    let groupIndex = 0;
    groupIndex < totalBatches;
    groupIndex += concurrentBatches
  ) {
    const batchPromises = [];

    // Create up to concurrentBatches number of promises
    for (
      let i = 0;
      i < concurrentBatches && groupIndex + i < totalBatches;
      i++
    ) {
      const batchIndex = groupIndex + i;
      const start = batchIndex * batchSize;
      const end = Math.min(start + batchSize, asinsData.length);
      const currentBatch = asinsData.slice(start, end);

      const batchPromise = (async () => {
        let retryCount = 0;
        let processed = false;

        console.log(`Processing batch ${batchIndex + 1}/${totalBatches}`);

        while (!processed && retryCount < maxRetries) {
          const tokensLeft = await checkTokenAmount();
          const requiredTokens =
            tokenMultiplierBasedOnParams * currentBatch.length;

          if (tokensLeft < requiredTokens) {
            retryCount++;
            console.log(
              `Batch ${batchIndex + 1}/${totalBatches}: ` +
                `Insufficient tokens. Required: ${requiredTokens}, Available: ${tokensLeft}`
            );
            console.log(
              `Waiting ${
                retryDelay / 1000 / 60
              } minutes before retry ${retryCount}/${maxRetries}`
            );
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            continue;
          }

          try {
            const keepaData = await fetchKeepaData(
              currentBatch.map((item) => item.ASIN),
              2
            );
            const processedKeepaEntries = keepaData.products.map(
              (item: any) => {
                if (!(item?.title?.length > 0)) {
                  return {
                    asin: item.asin,
                    exists: false,
                  };
                } else {
                  const availableOnAmazon =
                    item?.availabilityAmazon != null &&
                    item.availabilityAmazon >= 0;

                  let amazonCurrent;
                  if (item?.stats?.buyBoxIsAmazon) {
                    amazonCurrent = item?.stats?.buyBoxPrice;
                  } else {
                    const csvArray = item?.csv[0];
                    amazonCurrent = csvArray?.[csvArray?.length - 1];
                  }
                  return {
                    asin: item?.asin,
                    packageWeight: item?.packageWeight,
                    buyBoxPrice: item?.stats?.buyBoxPrice,
                    amazonCurrent,
                    availableOnAmazon,
                    exists: true,
                  };
                }
              }
            );
            console.log(
              `Batch ${batchIndex + 1}/${totalBatches} processed successfully`
            );
            processed = true;

            await prisma.$transaction(
              processedKeepaEntries.map((entry: any) => {
                let dataToUpdate;
                if (entry.exists) {
                  dataToUpdate = {
                    ukPackageWeight: entry.packageWeight as number,
                    ukBuyBoxPrice: entry.buyBoxPrice as number,
                    ukAvailableOnAmazon: entry.availableOnAmazon as boolean,
                    ukAmazonCurrent: entry.amazonCurrent as number,
                    hasBeenProcessedUk: true,
                  };
                } else {
                  dataToUpdate = {
                    hasBeenProcessedUk: true,
                  };
                }
                return prisma.sample_a2a.update({
                  where: {
                    ASIN: entry.asin,
                  },
                  data: dataToUpdate,
                });
              })
            );
          } catch (error) {
            console.error(`Error processing batch ${batchIndex + 1}:`, error);
            retryCount++;
            await new Promise((resolve) => setTimeout(resolve, 30000));
          }
        }

        if (!processed) {
          console.log(
            `Failed to process batch ${
              batchIndex + 1
            }/${totalBatches} after ${maxRetries} retries. ` +
              `Skipping ${currentBatch.length} ASINs.`
          );
        }
      })();

      batchPromises.push(batchPromise);
    }

    // Wait for all concurrent batches to complete before moving to next group
    await Promise.all(batchPromises);

    // Log progress after each group of concurrent batches
    if ((groupIndex + concurrentBatches) % 1000 === 0) {
      console.log(
        `Milestone: Processed ${groupIndex + concurrentBatches} batches`
      );
    }
  }
};

export const populateUsDbFields = async () => {
  console.log("Running scheduled job");
  const asinsData = await fetchAsinsToPopulateUsDbFields();
  if (!asinsData) {
    console.log("No data to process");
    return;
  }

  const batchSize = 100; // Keepa's limit
  const concurrentBatches = 10; // Number of concurrent requests
  const maxRetries = 5;
  const retryDelay = 5 * 60 * 1000; // 10 minutes
  const totalBatches = Math.ceil(asinsData.length / batchSize);

  console.log(
    `Starting to process ${asinsData.length} ASINs in ${totalBatches} batches`
  );

  // Process batches in groups of concurrentBatches
  for (
    let groupIndex = 0;
    groupIndex < totalBatches;
    groupIndex += concurrentBatches
  ) {
    const batchPromises = [];

    // Create up to concurrentBatches number of promises
    for (
      let i = 0;
      i < concurrentBatches && groupIndex + i < totalBatches;
      i++
    ) {
      const batchIndex = groupIndex + i;
      const start = batchIndex * batchSize;
      const end = Math.min(start + batchSize, asinsData.length);
      const currentBatch = asinsData.slice(start, end);

      const batchPromise = (async () => {
        let retryCount = 0;
        let processed = false;

        console.log(`Processing batch ${batchIndex + 1}/${totalBatches}`);

        while (!processed && retryCount < maxRetries) {
          const tokensLeft = await checkTokenAmount();
          const requiredTokens =
            tokenMultiplierBasedOnParams * currentBatch.length;

          if (tokensLeft < requiredTokens) {
            retryCount++;
            console.log(
              `Batch ${batchIndex + 1}/${totalBatches}: ` +
                `Insufficient tokens. Required: ${requiredTokens}, Available: ${tokensLeft}`
            );
            console.log(
              `Waiting ${
                retryDelay / 1000 / 60
              } minutes before retry ${retryCount}/${maxRetries}`
            );
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            continue;
          }

          try {
            const keepaData = await fetchKeepaData(
              currentBatch.map((item) => item.ASIN),
              1
            );
            const processedKeepaEntries = keepaData.products.map(
              (item: any, index: number) => {
                if (!(item?.title?.length > 0)) {
                  return {
                    asin: item.asin,
                    exists: false,
                  };
                } else {
                  return {
                    asin: item.asin,
                    bsrDrop: item?.stats?.salesRankDrops30,
                    buyBoxPrice: item?.stats?.buyBoxPrice,
                    fbaFee: item?.fbaFees?.pickAndPackFee,
                    referralFee: item?.referralFeePercent,
                    exists: true,
                  };
                }
              }
            );
            console.log(
              `Batch ${batchIndex + 1}/${totalBatches} processed successfully`
            );
            processed = true;

            await prisma.$transaction(
              processedKeepaEntries.map((entry: any) => {
                let dataToUpdate;
                if (entry.exists) {
                  dataToUpdate = {
                    usBsrDrop: entry.bsrDrop as number,
                    usBuyBoxPrice: entry.buyBoxPrice as number,
                    usFbaFee: entry.fbaFee as number,
                    usReferralFee: entry.referralFee as number,
                    hasBeenProcessedUs: true,
                  };
                } else {
                  dataToUpdate = {
                    hasBeenProcessedUs: true,
                  };
                }
                return prisma.sample_a2a.update({
                  where: {
                    ASIN: entry.asin,
                  },
                  data: dataToUpdate,
                });
              })
            );
          } catch (error) {
            console.error(`Error processing batch ${batchIndex + 1}:`, error);
            retryCount++;
            await new Promise((resolve) => setTimeout(resolve, 30000));
          }
        }

        if (!processed) {
          console.log(
            `Failed to process batch ${
              batchIndex + 1
            }/${totalBatches} after ${maxRetries} retries. ` +
              `Skipping ${currentBatch.length} ASINs.`
          );
        }
      })();

      batchPromises.push(batchPromise);
    }

    // Wait for all concurrent batches to complete before moving to next group
    await Promise.all(batchPromises);

    // Log progress after each group of concurrent batches
    if ((groupIndex + concurrentBatches) % 1000 === 0) {
      console.log(
        `Milestone: Processed ${groupIndex + concurrentBatches} batches`
      );
    }
  }
};

export async function fetchUnprocessedAsins() {
  const data = await prisma.sample_a2a.findMany({
    where: {
      hasBeenProcessed: "f",
      // hasBeenProcessedUk: false,
      // hasBeenProcessedUs: false
    },
    take: 500000,
  });
  return data;
}

export const processAsins = async () => {
  console.log("Running scheduled job");
  const asinsData = await fetchUnprocessedAsins();
  if (!asinsData) {
    console.log("No data to process");
    return;
  }

  const batchSize = 100; // Keepa's limit
  const concurrentBatches = 10; // Number of concurrent requests
  const maxRetries = 5;
  const retryDelay = 5 * 60 * 1000; // 5 minutes
  const totalBatches = Math.ceil(asinsData.length / batchSize);

  console.log(
    `Starting to process ${asinsData.length} ASINs in ${totalBatches} batches`
  );

  // Process batches in groups of concurrentBatches
  for (
    let groupIndex = 0;
    groupIndex < totalBatches;
    groupIndex += concurrentBatches
  ) {
    const batchPromises = [];

    // Create up to concurrentBatches number of promises
    for (
      let i = 0;
      i < concurrentBatches && groupIndex + i < totalBatches;
      i++
    ) {
      const batchIndex = groupIndex + i;
      const start = batchIndex * batchSize;
      const end = Math.min(start + batchSize, asinsData.length);
      const currentBatch = asinsData.slice(start, end);

      const batchPromise = (async () => {
        let retryCount = 0;
        let processed = false;

        console.log(`Processing batch ${batchIndex + 1}/${totalBatches}`);

        while (!processed && retryCount < maxRetries) {
          const tokensLeft = await checkTokenAmount();
          const requiredTokens =
            tokenMultiplierBasedOnParams * currentBatch.length * 2;

          if (tokensLeft < requiredTokens) {
            retryCount++;
            console.log(
              `Batch ${batchIndex + 1}/${totalBatches}: ` +
                `Insufficient tokens. Required: ${requiredTokens}, Available: ${tokensLeft}`
            );
            console.log(
              `Waiting ${
                retryDelay / 1000 / 60
              } minutes before retry ${retryCount}/${maxRetries}`
            );
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            continue;
          }

          try {
            // First get UK data (domain 2)
            const ukKeepaData = await fetchKeepaData(
              currentBatch.map((item) => item.ASIN),
              2
            );

            // Then get US data (domain 1) for ASINs that exist in UK
            const usProductsWhichExistInUk = ukKeepaData.products.filter(
              (item: any) => item?.title?.length > 0
            );
            const usKeepaData = await fetchKeepaData(
              usProductsWhichExistInUk.map((item: any) => item.asin),
              1
            );

            // Create a map of US data for easy lookup
            const usDataMap = new Map(
              usKeepaData.products.map((item: any) => [item.asin, item])
            );

            // Combine UK and US data
            const processedKeepaEntries = ukKeepaData.products.map(
              (ukItem: any) => {
                if (!(ukItem?.title?.length > 0)) {
                  return {
                    asin: ukItem.asin,
                    exists: false,
                  };
                }

                const usItem = usDataMap.get(ukItem.asin) as any;
                const ukAvailableOnAmazon =
                  ukItem?.availabilityAmazon != null &&
                  ukItem.availabilityAmazon >= 0;

                let ukAmazonCurrent;
                if (ukItem?.stats?.buyBoxIsAmazon) {
                  ukAmazonCurrent = ukItem?.stats?.buyBoxPrice;
                } else {
                  const csvArray = ukItem?.csv[0];
                  ukAmazonCurrent = csvArray[csvArray.length - 1];
                }

                return {
                  asin: ukItem.asin,
                  exists: true,
                  // UK data
                  ukPackageWeight: ukItem?.packageWeight,
                  ukBuyBoxPrice: ukItem?.stats?.buyBoxPrice,
                  ukAvailableOnAmazon,
                  ukAmazonCurrent,
                  // US data
                  usBsrDrop: usItem?.stats?.salesRankDrops30,
                  usBuyBoxPrice: usItem?.stats?.buyBoxPrice,
                  usFbaFee: usItem?.fbaFees?.pickAndPackFee,
                  usReferralFee: usItem?.referralFeePercent,
                  usAvgBb90Day: usItem?.stats?.avg90?.[18],
                  usAvgBb360Day: usItem?.stats?.avg365?.[18],
                };
              }
            );

            console.log(
              `Batch ${batchIndex + 1}/${totalBatches} processed successfully`
            );
            processed = true;

            await prisma.$transaction(
              processedKeepaEntries.map((entry: any) => {
                let dataToUpdate;
                if (entry.exists) {
                  dataToUpdate = {
                    // UK data
                    ukPackageWeight: entry.ukPackageWeight as number,
                    ukBuyBoxPrice: entry.ukBuyBoxPrice as number,
                    ukAvailableOnAmazon: entry.ukAvailableOnAmazon ? "t" : "f",
                    // ukAvailableOnAmazon: entry.ukAvailableOnAmazon as boolean,
                    ukAmazonCurrent: entry.ukAmazonCurrent as number,
                    // US data
                    usBsrDrop: entry.usBsrDrop as number,
                    usBuyBoxPrice: entry.usBuyBoxPrice as number,
                    usFbaFee: entry.usFbaFee as number,
                    usReferralFee: entry.usReferralFee as number,
                    usAvgBb90Day: entry.usAvgBb90Day as number,
                    usAvgBb360Day: entry.usAvgBb360Day as number,
                    hasBeenProcessed: "t",  // Convert boolean to string
                    existsInUk: "t", 
                    // hasBeenProcessed: true,
                    // existsInUk: true,
                  };
                } else {
                  dataToUpdate = {
                    hasBeenProcessed: true,
                    existsInUk: false,
                  };
                }
                return prisma.sample_a2a.update({
                  where: {
                    ASIN: entry.asin,
                  },
                  data: dataToUpdate,
                });
              })
            );
          } catch (error) {
            console.error(`Error processing batch ${batchIndex + 1}:`, error);
            retryCount++;
            await new Promise((resolve) => setTimeout(resolve, 30000));
          }
        }

        if (!processed) {
          console.log(
            `Failed to process batch ${
              batchIndex + 1
            }/${totalBatches} after ${maxRetries} retries. ` +
              `Skipping ${currentBatch.length} ASINs.`
          );
        }
      })();

      batchPromises.push(batchPromise);
    }

    // Wait for all concurrent batches to complete before moving to next group
    await Promise.all(batchPromises);

    // Log progress after each group of concurrent batches
    if ((groupIndex + concurrentBatches) % 1000 === 0) {
      console.log(
        `Milestone: Processed ${groupIndex + concurrentBatches} batches`
      );
    }
  }
};
