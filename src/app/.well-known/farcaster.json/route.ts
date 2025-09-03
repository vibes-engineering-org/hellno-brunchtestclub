import { PROJECT_TITLE } from "~/lib/constants";

export async function GET() {
  const appUrl = process.env.NEXT_PUBLIC_URL;

  const config = {
    accountAssociation: {
      header:
        "eyJmaWQiOjg2OTk5OSwidHlwZSI6ImN1c3RvZHkiLCJrZXkiOiIweDc2ZDUwQjBFMTQ3OWE5QmEyYkQ5MzVGMUU5YTI3QzBjNjQ5QzhDMTIifQ",
      payload:
        "eyJkb21haW4iOiJoZWxsbm8tYnJ1bmNodGVzdGNsdWIudmVyY2VsLmFwcCJ9",
      signature:
        "MHhkYjM1MTMwNTJhZDRhM2U4YjIzYjI4NzBkYzE3YWRjZjY1YzljNGJiZmFiNGRkNGNhNzY2MDQ0YTdmNGRjNjdjMGY2MmE3MzJjOGIzMjk0OGY3Yzc3NmYwNjc2OWM3Y2MwYTM1YmM2MzA1MzBjYTkxN2FjOGMyNDdjMjhhNTEwODFi",
    },
    frame: {
      version: "1",
      name: PROJECT_TITLE,
      iconUrl: `${appUrl}/icon.png`,
      homeUrl: appUrl,
      imageUrl: `${appUrl}/og.png`,
      buttonTitle: "Open",
      splashImageUrl: `${appUrl}/splash.png`,
      splashBackgroundColor: "#f7f7f7",
      webhookUrl: `${appUrl}/api/webhook`,
      primaryCategory: "social",
    },
  };

  return Response.json(config);
}
