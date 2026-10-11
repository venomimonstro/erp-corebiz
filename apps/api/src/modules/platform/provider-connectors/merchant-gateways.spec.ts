import {BadGatewayException} from "@nestjs/common";
import {AtolOnlineGateway,CdekGateway} from "./merchant-gateways";

const cdek={clientId:"test-client",clientSecret:"test-secret-long"};
const atol={login:"atol-account",password:"atol-password",groupCode:"GROUP_01"};
function reply(body:unknown){
  return {
    ok:true,status:200,
    headers:{get:(_key:string)=>null},
    text:async()=>JSON.stringify(body)
  } as Response;
}
describe("seller CDEK and ATOL fixed-provider adapters",()=>{
  afterEach(()=>jest.restoreAllMocks());

  it("contacts only the fixed CDEK sandbox OAuth host",async()=>{
    const fetchMock=jest.spyOn(global,"fetch")
      .mockResolvedValueOnce(reply({access_token:"fake-jwt",expires_in:3600}));
    const token=await new CdekGateway().token(cdek,"SANDBOX");
    expect(token).toBe("fake-jwt");
    const url=String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe("https://api.edu.cdek.ru/v2/oauth/token");
    expect(url).not.toContain(cdek.clientSecret);
    const init=fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
  });

  it("requests a real tariff and rounds money to integer kopeks",async()=>{
    const fetchMock=jest.spyOn(global,"fetch")
      .mockResolvedValueOnce(reply({access_token:"jwt",expires_in:3600}))
      .mockResolvedValueOnce(reply({tariff_codes:[
        {tariff_code:136,delivery_sum:523.4,period_min:2,period_max:4},
        {tariff_code:0,delivery_sum:-1}
      ]}));
    const rows=await new CdekGateway().rates(cdek,"PRODUCTION",{
      fromCityCode:44,toCityCode:137,weightGrams:800,
      lengthCm:15,widthCm:20,heightCm:10
    });
    expect(rows).toEqual([{
      tariffCode:136,deliverySumMinor:"52340",periodMin:2,periodMax:4
    }]);
    expect(String(fetchMock.mock.calls[1]?.[0]))
      .toBe("https://api.cdek.ru/v2/calculator/tarifflist");
    const body=JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body.packages[0].weight).toBe(800);
    expect(fetchMock.mock.calls[1]?.[1]?.headers)
      .toEqual(expect.objectContaining({Authorization:"Bearer jwt"}));
  });

  it("does not accept missing or invalid CDEK tariff responses",async()=>{
    jest.spyOn(global,"fetch")
      .mockResolvedValueOnce(reply({access_token:"jwt"}))
      .mockResolvedValueOnce(reply({error:"invalid tariff"}));
    await expect(new CdekGateway().rates(cdek,"SANDBOX",{
      fromCityCode:44,toCityCode:137,weightGrams:1000,
      lengthCm:20,widthCm:20,heightCm:20
    })).rejects.toBeInstanceOf(BadGatewayException);
  });

  it("tests ATOL FFD 1.2 credentials without issuing a receipt",async()=>{
    const mock=jest.spyOn(global,"fetch")
      .mockResolvedValueOnce(reply({token:"some-auth-token",error:null}));
    await expect(new AtolOnlineGateway().verify(atol,"SANDBOX"))
      .resolves.toEqual({authorized:true});
    const url=String(mock.mock.calls[0]?.[0]);
    expect(url).toBe("https://testonline.atol.ru/possystem/v5/getToken");
    expect(url).not.toContain("sell");
    expect(JSON.parse(String(mock.mock.calls[0]?.[1]?.body)).pass)
      .toBe(atol.password);
  });
  it("fails closed when ATOL response has an explicit API error",async()=>{
    jest.spyOn(global,"fetch")
      .mockResolvedValueOnce(reply({
        error:{code:12,text:"wrong password"},token:null
      }));
    await expect(new AtolOnlineGateway().verify(atol,"PRODUCTION"))
      .rejects.toBeInstanceOf(BadGatewayException);
  });
});
