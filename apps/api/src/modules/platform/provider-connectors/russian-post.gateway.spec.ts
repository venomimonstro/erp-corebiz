import {BadGatewayException,ServiceUnavailableException} from "@nestjs/common";
import {RussianPostGateway} from "./russian-post.gateway";
const creds={
  accessToken:"exampleAccessToken12345678",
  userAuthorizationKey:"dXNlcm5hbWU6cGFzc3dvcmQ="
};
const reply=(body:unknown):Response=>({
  ok:true,status:200,
  headers:{get:(_name:string)=>null},
  text:async()=>JSON.stringify(body)
} as Response);
describe("Russian Post official тариф REST adapter",()=>{
  afterEach(()=>jest.restoreAllMocks());
  it("requests only the official fixed HTTPS tariff endpoint",async()=>{
    const mock=jest.spyOn(global,"fetch")
      .mockResolvedValueOnce(reply({
        "total-rate":30658,"total-vat":6132,
        "delivery-time":{"min-days":1,"max-days":3}
      }));
    const row=await new RussianPostGateway().tariff(creds,{
      fromPostcode:"010000",toPostcode:"644015",massGrams:1000
    });
    expect(row).toMatchObject({
      fromPostcode:"010000",toPostcode:"644015",
      mailType:"POSTAL_PARCEL",amountMinor:"36790",
      rateMinor:"30658",vatMinor:"6132",
      periodMin:1,periodMax:3
    });
    const [url,init]=mock.mock.calls[0]!;
    expect(url).toBe("https://otpravka-api.pochta.ru/1.0/tariff");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual(expect.objectContaining({
      Authorization:"AccessToken "+creds.accessToken,
      "X-User-Authorization":"Basic "+creds.userAuthorizationKey
    }));
    expect(JSON.parse(String(init?.body))["mail-type"]).toBe("POSTAL_PARCEL");
  });
  it("rejects missing or non-integer prices rather than fake estimated tariffs",async()=>{
    jest.spyOn(global,"fetch").mockResolvedValueOnce(reply({
      "total-rate":"30658","total-vat":6132
    }));
    await expect(new RussianPostGateway().tariff(creds,{
      fromPostcode:"109440",toPostcode:"644015",massGrams:1000
    })).rejects.toBeInstanceOf(BadGatewayException);
  });
  it("refuses malformed destination, oversized mass and invalid credentials before network",async()=>{
    const fetchMock=jest.spyOn(global,"fetch");
    await expect(new RussianPostGateway().tariff(creds,{
      fromPostcode:"109440",toPostcode:"notpostal",massGrams:1000
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(new RussianPostGateway().tariff(creds,{
      fromPostcode:"109440",toPostcode:"644015",massGrams:90000
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(new RussianPostGateway().tariff({
      accessToken:"bad",userAuthorizationKey:creds.userAuthorizationKey
    },{
      fromPostcode:"109440",toPostcode:"644015",massGrams:1000
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
