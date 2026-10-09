import { HttpException, HttpStatus, type ArgumentsHost } from "@nestjs/common";
import { ApiExceptionFilter } from "./api-exception.filter";

function host() {
  const status = jest.fn().mockReturnThis();
  const json = jest.fn();
  const request = {traceId:"test-trace-01",method:"POST"};
  const response = {status,json};
  const argumentsHost = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response
    })
  } as unknown as ArgumentsHost;
  return {argumentsHost,status,json};
}

describe("safe API exceptions", () => {
  it("does not expose raw internal 500 message", () => {
    const h=host();
    new ApiExceptionFilter().catch(
      new HttpException({message:"secret-db-connection-details"},
        HttpStatus.INTERNAL_SERVER_ERROR), h.argumentsHost
    );
    expect(h.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(h.json.mock.calls)).not.toContain("secret-db-connection-details");
    expect(h.json).toHaveBeenCalledWith(expect.objectContaining({ok:false}));
  });
  it("keeps actionable validation errors for 400 status", () => {
    const h=host();
    new ApiExceptionFilter().catch(
      new HttpException("Некорректные данные", HttpStatus.BAD_REQUEST),
      h.argumentsHost
    );
    expect(JSON.stringify(h.json.mock.calls)).toContain("Некорректные данные");
  });
});
