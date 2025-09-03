"use client";

import { PROJECT_TITLE } from "~/lib/constants";
import { NFTMintFlow } from "~/components/nft-mint-flow";

export default function App() {
  return (
    <div className="w-[400px] mx-auto py-8 px-4 min-h-screen flex flex-col items-center justify-center">
      {/* TEMPLATE_CONTENT_START - Replace content below */}
      <div className="space-y-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">
          Mint Your NFT
        </h1>
        <p className="text-muted-foreground">
          Connect your wallet and mint in just two clicks
        </p>
      </div>
      
      <div className="w-full max-w-[350px] mt-8">
        <NFTMintFlow
          contractAddress="0xcd0Bafa3BBa1b32869343fB69D2778daF4412181"
          tokenId="1"
          network="gnosis"
          buttonText="Mint NFT"
        />
      </div>
      {/* TEMPLATE_CONTENT_END */}
    </div>
  );
}
