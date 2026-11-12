import { proxyCallable } from "@/lib/carta/proxy"
export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
  return proxyCallable((await params).name, request)
}
