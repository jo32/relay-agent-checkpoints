import { getAuth, prepareAuthStorage } from "../../../../lib/auth";

export const dynamic = "force-dynamic";

async function handleAuth(request: Request): Promise<Response> {
  await prepareAuthStorage();
  return getAuth().handler(request);
}

export { handleAuth as GET, handleAuth as POST };
