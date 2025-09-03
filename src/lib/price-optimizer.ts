import type { PublicClient } from "viem";
import type { NFTContractInfo, MintParams } from "~/lib/types";
import { getProviderConfig } from "~/lib/provider-configs";
import { THIRDWEB_OPENEDITONERC721_ABI, THIRDWEB_NATIVE_TOKEN, MANIFOLD_ERC721_EXTENSION_ABI, MANIFOLD_ERC1155_EXTENSION_ABI } from "~/lib/nft-standards";

/**
 * Helper function to try Manifold contract calls with ABI fallback
 */
async function callManifoldWithFallback(
  client: PublicClient,
  address: string,
  functionName: string,
  args: any[],
  contractInfo: NFTContractInfo
): Promise<any> {
  // First, try with the detected contract type ABI
  const primaryABI = contractInfo.isERC721 ? MANIFOLD_ERC721_EXTENSION_ABI : MANIFOLD_ERC1155_EXTENSION_ABI;
  const fallbackABI = contractInfo.isERC721 ? MANIFOLD_ERC1155_EXTENSION_ABI : MANIFOLD_ERC721_EXTENSION_ABI;
  
  const contractType = contractInfo.isERC721 ? "ERC721" : (contractInfo.isERC1155 ? "ERC1155" : "Unknown");
  console.log(`[Manifold Fallback] Attempting ${functionName} with ${contractType} ABI first`);
  
  try {
    const result = await client.readContract({
      address: address as `0x${string}`,
      abi: primaryABI,
      functionName: functionName as any,
      args: args as any
    });
    console.log(`[Manifold Fallback] ✅ Success with ${contractType} ABI`);
    return result;
  } catch (primaryError) {
    console.log(`[Manifold Fallback] ❌ Failed with ${contractType} ABI, trying fallback:`, (primaryError as Error).message);
    
    try {
      const fallbackType = contractInfo.isERC721 ? "ERC1155" : "ERC721";
      const result = await client.readContract({
        address: address as `0x${string}`,
        abi: fallbackABI,
        functionName: functionName as any,
        args: args as any
      });
      console.log(`[Manifold Fallback] ✅ Success with fallback ${fallbackType} ABI`);
      return result;
    } catch (fallbackError) {
      console.log(`[Manifold Fallback] ❌ Both ABIs failed:`, (fallbackError as Error).message);
      throw fallbackError;
    }
  }
}

/**
 * Optimized price discovery that batches RPC calls where possible
 */
export async function fetchPriceData(
  client: PublicClient,
  params: MintParams,
  contractInfo: NFTContractInfo
): Promise<{
  mintPrice?: bigint;
  erc20Details?: {
    address: string;
    symbol: string;
    decimals: number;
    allowance?: bigint;
    balance?: bigint;
  };
  totalCost: bigint;
  claim?: NFTContractInfo["claim"];
}> {
  const config = getProviderConfig(contractInfo.provider, contractInfo);
  
  if (contractInfo.provider === "manifold" && contractInfo.extensionAddress) {
    // For Manifold, we need extension fee + claim cost
    console.log(`[Manifold Price] Processing contract type: ERC721=${contractInfo.isERC721}, ERC1155=${contractInfo.isERC1155}`);
    
    try {
      // First get MINT_FEE - this is consistent across both contract versions
      const mintFeePromise = callManifoldWithFallback(
        client,
        contractInfo.extensionAddress,
        "MINT_FEE",
        [],
        contractInfo
      );
      
      // Then get claim data if we have instanceId or tokenId
      let claimPromise: Promise<any> | null = null;
      
      if (params.instanceId) {
        console.log(`[Manifold Price] Fetching claim data for instanceId: ${params.instanceId}`);
        claimPromise = callManifoldWithFallback(
          client,
          contractInfo.extensionAddress,
          "getClaim",
          [params.contractAddress, BigInt(params.instanceId)],
          contractInfo
        );
      } else if (params.tokenId) {
        console.log(`[Manifold Price] Fetching claim data for tokenId: ${params.tokenId}`);
        claimPromise = callManifoldWithFallback(
          client,
          contractInfo.extensionAddress,
          "getClaimForToken",
          [params.contractAddress, BigInt(params.tokenId)],
          contractInfo
        );
      }
      
      // Execute both promises
      const [mintFee, claimData] = await Promise.all([
        mintFeePromise.catch(err => {
          console.error("[Manifold Price] MINT_FEE call failed:", err);
          return null;
        }),
        claimPromise ? claimPromise.catch(err => {
          console.error("[Manifold Price] Claim data call failed:", err);
          return null;
        }) : Promise.resolve(null)
      ]);
      
      let claim = claimData;
      
      // Handle getClaimForToken response format [instanceId, claim]
      if (claim && Array.isArray(claim) && claim.length === 2 && params.tokenId) {
        console.log("Got getClaimForToken response, extracting claim data");
        const [extractedInstanceId, claimData] = claim;
        claim = claimData;
        // Update params with the extracted instanceId for consistency
        if (!params.instanceId) {
          params.instanceId = extractedInstanceId.toString();
        }
      }
      
      // Validate claim data structure before accessing properties
      if (claim && (params.instanceId || params.tokenId)) {
        // Check if claim is a valid object with expected properties
        if (typeof claim !== "object" || claim.cost === undefined) {
          console.error(`Invalid claim data for instanceId ${params.instanceId}:`, claim);
          console.warn(`This may indicate the instanceId ${params.instanceId} doesn't exist or the claim has expired`);
          // Continue with just the mint fee, don't fail completely
          return {
            mintPrice: mintFee || BigInt(0),
            totalCost: mintFee || BigInt(0)
          };
        }
        
        // Validate required claim properties
        const requiredProps = ["cost", "erc20", "startDate", "endDate", "walletMax"];
        const missingProps = requiredProps.filter(prop => claim[prop] === undefined);
        if (missingProps.length > 0) {
          console.error(`Claim data missing required properties: ${missingProps.join(",")}`);
          return {
            mintPrice: mintFee || BigInt(0),
            totalCost: mintFee || BigInt(0)
          };
        }
        
        // Validate data types
        if (typeof claim.cost !== "bigint" && typeof claim.cost !== "number") {
          console.error("Invalid claim.cost type:", typeof claim.cost, claim.cost);
          return {
            mintPrice: mintFee || BigInt(0),
            totalCost: mintFee || BigInt(0)
          };
        }
      }
      
      let totalCost = mintFee || BigInt(0);
      let erc20Details = undefined;
      
      if (claim) {
        // Store claim data in contractInfo for later use
        contractInfo.claim = {
          cost: claim.cost,
          merkleRoot: claim.merkleRoot,
          erc20: claim.erc20,
          startDate: claim.startDate,
          endDate: claim.endDate,
          walletMax: claim.walletMax
        };
        
        // Check if ERC20 payment
        if (claim.erc20 && claim.erc20 !== "0x0000000000000000000000000000000000000000") {
          // Batch ERC20 details fetch
          const [symbol, decimals, allowance, balance] = await Promise.all([
            client.readContract({
              address: claim.erc20,
              abi: [{ name: "symbol", type: "function", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" }],
              functionName: "symbol"
            }),
            client.readContract({
              address: claim.erc20,
              abi: [{ name: "decimals", type: "function", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" }],
              functionName: "decimals"
            }),
            params.recipient ? client.readContract({
              address: claim.erc20,
              abi: [{ 
                name: "allowance", 
                type: "function", 
                inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], 
                outputs: [{ type: "uint256" }], 
                stateMutability: "view" 
              }],
              functionName: "allowance",
              args: [params.recipient, contractInfo.extensionAddress || params.contractAddress]
            }).catch(() => BigInt(0)) : Promise.resolve(undefined), // Return undefined when no recipient, not 0
            params.recipient ? client.readContract({
              address: claim.erc20,
              abi: [{ 
                name: "balanceOf", 
                type: "function", 
                inputs: [{ name: "owner", type: "address" }], 
                outputs: [{ type: "uint256" }], 
                stateMutability: "view" 
              }],
              functionName: "balanceOf",
              args: [params.recipient]
            }).catch(() => BigInt(0)) : Promise.resolve(undefined)
          ]);
          
          // Validate decimals
          const validatedDecimals = Number(decimals);
          if (isNaN(validatedDecimals) || validatedDecimals < 0 || validatedDecimals > 255) {
            console.error(`Invalid ERC20 decimals for ${claim.erc20}:`, decimals);
            throw new Error(`Invalid ERC20 decimals: ${decimals}`);
          }
          
          erc20Details = {
            address: claim.erc20,
            symbol: symbol as string,
            decimals: validatedDecimals,
            allowance: allowance as bigint,
            balance: balance as bigint | undefined
          };
          
          // For ERC20, total cost in ETH is just the mint fee
          totalCost = mintFee || BigInt(0);
        } else {
          // ETH payment - add claim cost to mint fee
          totalCost = (mintFee || BigInt(0)) + (claim.cost || BigInt(0));
        }
      }
      
      return {
        mintPrice: mintFee || BigInt(0),
        erc20Details,
        totalCost,
        claim: claim ? contractInfo.claim : undefined
      };
    } catch (err) {
      console.error("[Manifold Price] Failed to fetch complete Manifold price data:", err);
      
      // Fallback: Try to get just the mint fee without claim data
      try {
        console.log("[Manifold Price] Attempting fallback to retrieve MINT_FEE only");
        const mintFee = await callManifoldWithFallback(
          client,
          contractInfo.extensionAddress,
          "MINT_FEE",
          [],
          contractInfo
        );
        
        console.log("[Manifold Price] ✅ Fallback: Retrieved mint fee only:", mintFee);
        return {
          mintPrice: mintFee as bigint,
          totalCost: mintFee as bigint
        };
      } catch (fallbackErr) {
        console.error("[Manifold Price] ❌ All fallback attempts failed:", fallbackErr);
        console.log("[Manifold Price] Using default Manifold fee of 0.0005 ETH");
        return { 
          totalCost: BigInt("500000000000000") // Default 0.0005 ETH Manifold fee
        };
      }
    }
  } else if (contractInfo.provider === "nfts2me") {
    // Special handling for nfts2me - try different pricing patterns
    
    // Pattern 1: Try mintPrice() first - for simple/free NFTs2Me contracts
    try {
      const mintPrice = await client.readContract({
        address: params.contractAddress,
        abi: [{
          inputs: [],
          name: "mintPrice",
          outputs: [{ name: "", type: "uint256" }],
          stateMutability: "view",
          type: "function"
        }],
        functionName: "mintPrice",
        args: []
      });
      
      if (mintPrice !== undefined) {
        // mintPrice() returns the price per NFT
        const pricePerNFT = mintPrice as bigint;
        const totalCost = pricePerNFT * BigInt(params.amount || 1);
        
        // Handle free mints (mintPrice = 0)
        return {
          mintPrice: pricePerNFT,
          totalCost: totalCost
        };
      }
    } catch (err) {
      // mintPrice() doesn't exist, try next pattern
      console.log("mintPrice() not found, trying mintFee pattern");
    }
    
    // Pattern 2: Try mintFee(amount) + protocolFee() - for more complex pricing
    try {
      // Fetch both fees in parallel
      const [mintFee, protocolFee] = await Promise.all([
        // mintFee is the creator's revenue per NFT
        client.readContract({
          address: params.contractAddress,
          abi: [{
            inputs: [{ name: "amount", type: "uint256" }],
            name: "mintFee",
            outputs: [{ name: "", type: "uint256" }],
            stateMutability: "view",
            type: "function"
          }],
          functionName: "mintFee",
          args: [BigInt(params.amount || 1)]
        }),
        // protocolFee is the platform fee (0.0001 ETH unless disabled)
        client.readContract({
          address: params.contractAddress,
          abi: [{
            inputs: [],
            name: "protocolFee",
            outputs: [{ name: "", type: "uint256" }],
            stateMutability: "view",
            type: "function"
          }],
          functionName: "protocolFee",
          args: []
        })
      ]);
      
      if (mintFee !== undefined && protocolFee !== undefined) {
        // Total cost = creator revenue (mintFee) + platform fee (protocolFee * amount)
        const totalCost = (mintFee as bigint) + ((protocolFee as bigint) * BigInt(params.amount || 1));
        return {
          mintPrice: mintFee as bigint,
          totalCost: totalCost
        };
      }
    } catch (err) {
      console.error("Failed to fetch nfts2me fees:", err);
    }
    
    // Pattern 3: Fallback to default fees if all patterns fail
    const amount = BigInt(params.amount || 1);
    const creatorFeePerNFT = BigInt("100000000000000"); // 0.0001 ETH creator fee per NFT
    const protocolFeePerNFT = BigInt("100000000000000"); // 0.0001 ETH protocol fee per NFT
    return { 
      mintPrice: creatorFeePerNFT * amount,
      totalCost: (creatorFeePerNFT + protocolFeePerNFT) * amount
    };
  } else if (contractInfo.provider === "thirdweb") {
    // Check if it's an Extension contract first (ERC1155 with signature minting)
    if (contractInfo.isERC1155) {
      console.log(`[Price Optimizer] Thirdweb ERC1155 Extension detected, trying Extension pricing...`);
      
      // Pattern 1: Try to get price from common Extension functions
      try {
        // Many Extensions have a public price function
        const price = await client.readContract({
          address: params.contractAddress,
          abi: [
            {
              inputs: [],
              name: "price",
              outputs: [{ name: "", type: "uint256" }],
              stateMutability: "view",
              type: "function",
            },
          ],
          functionName: "price",
        });
        
        if (price && typeof price === 'bigint') {
          console.log(`[Price Optimizer] ✅ Found Extension price function: ${price}`);
          return {
            mintPrice: price * BigInt(params.amount || 1),
            totalCost: price * BigInt(params.amount || 1),
          };
        }
      } catch (error) {
        console.log(`[Price Optimizer] Extension price() function not found: ${error}`);
      }
      
      // Pattern 2: Try mintPrice function
      try {
        const mintPrice = await client.readContract({
          address: params.contractAddress,
          abi: [
            {
              inputs: [],
              name: "mintPrice",
              outputs: [{ name: "", type: "uint256" }],
              stateMutability: "view",
              type: "function",
            },
          ],
          functionName: "mintPrice",
        });
        
        if (mintPrice && typeof mintPrice === 'bigint') {
          console.log(`[Price Optimizer] ✅ Found Extension mintPrice function: ${mintPrice}`);
          return {
            mintPrice: mintPrice * BigInt(params.amount || 1),
            totalCost: mintPrice * BigInt(params.amount || 1),
          };
        }
      } catch (error) {
        console.log(`[Price Optimizer] Extension mintPrice() function not found: ${error}`);
      }
      
      // Pattern 3: Try to get price from claimCondition mapping (for ERC1155 Extensions)
      try {
        const claimCondition = await client.readContract({
          address: params.contractAddress,
          abi: [
            {
              inputs: [{ name: "tokenId", type: "uint256" }],
              name: "claimCondition",
              outputs: [
                { name: "startTimestamp", type: "uint256" },
                { name: "maxClaimableSupply", type: "uint256" },
                { name: "supplyClaimed", type: "uint256" },
                { name: "merkleRoot", type: "bytes32" },
                { name: "pricePerToken", type: "uint256" },
                { name: "currency", type: "address" },
                { name: "metadata", type: "string" },
              ],
              stateMutability: "view",
              type: "function",
            },
          ],
          functionName: "claimCondition",
          args: [0n], // Try with tokenId 0 (from successful transaction)
        });
        
        if (claimCondition && Array.isArray(claimCondition) && claimCondition.length >= 5) {
          const pricePerToken = claimCondition[4]; // Index 4 is pricePerToken
          if (typeof pricePerToken === 'bigint' && pricePerToken > 0n) {
            console.log(`[Price Optimizer] ✅ Found Extension claimCondition price: ${pricePerToken}`);
            return {
              mintPrice: pricePerToken * BigInt(params.amount || 1),
              totalCost: pricePerToken * BigInt(params.amount || 1),
            };
          }
        }
      } catch (error) {
        console.log(`[Price Optimizer] Extension claimCondition check failed: ${error}`);
      }
      
      // Pattern 4: Hardcoded fallback for known contracts (temporary solution)
      if (params.contractAddress.toLowerCase() === "0xcd0bafa3bba1b32869343fb69d2778daf4412181") {
        console.group("💰 [Price Optimizer] Using hardcoded price for known Extension");
        console.log("Contract address:", params.contractAddress);
        console.log("Amount:", params.amount);
        // 1 XDAI = 1e18 wei
        const oneXDAI = BigInt("1000000000000000000");
        const mintPrice = oneXDAI * BigInt(params.amount || 1);
        const totalCost = oneXDAI * BigInt(params.amount || 1);
        console.log("Unit price (XDAI):", "1");
        console.log("Total mint price:", mintPrice.toString(), "wei");
        console.log("Total cost:", totalCost.toString(), "wei");
        console.groupEnd();
        return {
          mintPrice,
          totalCost,
        };
      }
      
      console.log(`[Price Optimizer] ⚠️ Could not determine Extension price, defaulting to free`);
      return { mintPrice: BigInt(0), totalCost: BigInt(0) };
    }
    
    // Original Drop contract logic for ERC721
    try {
      // First get the active claim condition ID
      const claimCondition = await client.readContract({
        address: params.contractAddress,
        abi: THIRDWEB_OPENEDITONERC721_ABI,
        functionName: "claimCondition"
      });
      
      // Validate the response is an array with expected values
      if (!Array.isArray(claimCondition) || claimCondition.length !== 2) {
        throw new Error("Invalid claim condition response from contract");
      }
      
      const [currentStartId, count] = claimCondition as [bigint, bigint];
      
      if (count === BigInt(0)) {
        // No claim conditions set
        return { mintPrice: BigInt(0), totalCost: BigInt(0) };
      }
      
      // Get the active claim condition (last one)
      const activeConditionId = currentStartId + count - BigInt(1);
      
      const condition = await client.readContract({
        address: params.contractAddress,
        abi: THIRDWEB_OPENEDITONERC721_ABI,
        functionName: "getClaimConditionById",
        args: [activeConditionId]
      });
      
      if (!condition || typeof condition !== "object") {
        throw new Error("Invalid claim condition response");
      }
      
      const {
        startTimestamp,
        maxClaimableSupply,
        supplyClaimed,
        quantityLimitPerWallet,
        merkleRoot,
        pricePerToken,
        currency,
        metadata
      } = condition as any;
      
      // Store claim condition in contractInfo for later use
      contractInfo.claimCondition = {
        id: Number(activeConditionId),
        pricePerToken: pricePerToken as bigint,
        currency: currency as `0x${string}`,
        maxClaimableSupply: maxClaimableSupply as bigint,
        merkleRoot: merkleRoot as `0x${string}`,
        startTimestamp: Number(startTimestamp),
        quantityLimitPerWallet: quantityLimitPerWallet as bigint
      };
      
      // Check if it's ERC20 payment
      if (currency && currency.toLowerCase() !== THIRDWEB_NATIVE_TOKEN.toLowerCase()) {
        // ERC20 payment
        const [symbol, decimals, allowance, balance] = await Promise.all([
          client.readContract({
            address: currency,
            abi: [{ name: "symbol", type: "function", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" }],
            functionName: "symbol"
          }),
          client.readContract({
            address: currency,
            abi: [{ name: "decimals", type: "function", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" }],
            functionName: "decimals"
          }),
          params.recipient ? client.readContract({
            address: currency,
            abi: [{ 
              name: "allowance", 
              type: "function", 
              inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], 
              outputs: [{ type: "uint256" }], 
              stateMutability: "view" 
            }],
            functionName: "allowance",
            args: [params.recipient, params.contractAddress]
          }).catch(() => BigInt(0)) : Promise.resolve(undefined),
          params.recipient ? client.readContract({
            address: currency,
            abi: [{ 
              name: "balanceOf", 
              type: "function", 
              inputs: [{ name: "owner", type: "address" }], 
              outputs: [{ type: "uint256" }], 
              stateMutability: "view" 
            }],
            functionName: "balanceOf",
            args: [params.recipient]
          }).catch(() => BigInt(0)) : Promise.resolve(undefined)
        ]);
        
        // Validate decimals
        const validatedDecimals = Number(decimals);
        if (isNaN(validatedDecimals) || validatedDecimals < 0 || validatedDecimals > 255) {
          console.error(`Invalid ERC20 decimals for ${currency}:`, decimals);
          throw new Error(`Invalid ERC20 decimals: ${decimals}`);
        }
        
        return {
          mintPrice: pricePerToken as bigint,
          erc20Details: {
            address: currency,
            symbol: symbol as string,
            decimals: validatedDecimals,
            allowance: allowance as bigint,
            balance: balance as bigint | undefined
          },
          totalCost: BigInt(0) // No ETH needed for ERC20 payment
        };
      } else {
        // ETH payment
        const totalCost = (pricePerToken as bigint) * BigInt(params.amount || 1);
        return {
          mintPrice: pricePerToken as bigint,
          totalCost
        };
      }
    } catch (err) {
      console.error("Failed to fetch thirdweb price data:", err);
      return { totalCost: BigInt(0) };
    }
  } else {
    // Generic price discovery - try multiple function names
    const functionNames = config.priceDiscovery.functionNames;
    
    for (const functionName of functionNames) {
      try {
        // Check if this function requires an amount parameter
        const args = config.priceDiscovery.requiresAmountParam 
          ? [BigInt(params.amount || 1)]
          : [];
        
        const price = await client.readContract({
          address: params.contractAddress,
          abi: config.priceDiscovery.abis[0],
          functionName: functionName as any,
          args
        });
        
        if (price !== undefined) {
          // Calculate total cost based on provider's custom logic
          const totalCost = config.mintConfig.calculateValue(price as bigint, params);
          return {
            mintPrice: price as bigint,
            totalCost
          };
        }
      } catch {
        // Try next function name
        continue;
      }
    }
    
    // No price found, assume free mint
    return { mintPrice: BigInt(0), totalCost: BigInt(0) };
  }
}