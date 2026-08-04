import { nextVercelHandler } from "../../../../src/host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export const GET = nextVercelHandler;
export const POST = nextVercelHandler;
export const OPTIONS = nextVercelHandler;
