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

  it("submits CDEK order only after accepted response with UUID",async()=>{
    const fetchMock=jest.spyOn(global,"fetch")
      .mockResolvedValueOnce(reply({access_token:"jwt"}))
      .mockResolvedValueOnce(reply({
        entity:{uuid:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"},
        requests:[{state:"ACCEPTED"}]
      }));
    const result=await new CdekGateway().createOrder(cdek,"SANDBOX",{
      orderNumber:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      tariffCode:136,fromCityCode:44,toCityCode:137,
      recipientName:"Иван Иванов",recipientPhone:"+79998887766",
      deliveryAddress:"Москва, Ленина, 1",
      weightGrams:900,lengthCm:20,widthCm:15,heightCm:10,
      items:[{name:"Ноутбук",wareKey:"NOTEBOOK-1",cost:"45000.00",amount:1}]
    });
    expect(result.uuid).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const url=String(fetchMock.mock.calls[1]?.[0]);
    expect(url).toBe("https://api.edu.cdek.ru/v2/orders");
    const body=JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body.number).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(body.to_location.address).toBe("Москва, Ленина, 1");
    expect(body.packages[0].weight).toBe(900);
    expect(body.packages[0].items[0]).toEqual({
      name:"Ноутбук",ware_key:"NOTEBOOK-1",cost:45000,
      amount:1,payment:{value:0}
    });
  });
  it("fails closed on missing CDEK consignment UUID",async()=>{
    jest.spyOn(global,"fetch")
      .mockResolvedValueOnce(reply({access_token:"jwt"}))
      .mockResolvedValueOnce(reply({requests:[{state:"INVALID"}]}));
    await expect(new CdekGateway().createOrder(cdek,"SANDBOX",{
      orderNumber:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      tariffCode:136,fromCityCode:44,toCityCode:137,
      recipientName:"Иван Иванов",recipientPhone:"+79998887766",
      deliveryAddress:"Москва, Ленина, 1",
      weightGrams:900,lengthCm:20,widthCm:15,heightCm:10,
      items:[{name:"Ноутбук",wareKey:"NOTEBOOK-1",cost:"45000.00",amount:1}]
    })).rejects.toBeInstanceOf(BadGatewayException);
  });
  it("verifies CDEK order number against the returned carrier UUID",async()=>{
    const fetchMock=jest.spyOn(global,"fetch")
      .mockResolvedValueOnce(reply({access_token:"jwt"}))
      .mockResolvedValueOnce(reply({
        entity:{uuid:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          number:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          cdek_number:"12345",statuses:[{code:"DELIVERED"}]}
      }));
    const state=await new CdekGateway().orderStatus(
      cdek,"SANDBOX","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(state.clientOrderNumber).toBe(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(state.state).toBe("DELIVERED");
    expect(String(fetchMock.mock.calls[1]?.[0]))
      .toBe("https://api.edu.cdek.ru/v2/orders/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("submits an ATOL sell exactly once with a confirmed processing UUID",async()=>{
    const mock=jest.spyOn(global,"fetch")
      .mockResolvedValueOnce(reply({token:"valid-token"}))
      .mockResolvedValueOnce(reply({
        uuid:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status:"wait",error:null
      }));
    const receipt={external_id:"corebiz_test",timestamp:"12.10.2026 10:00:00",
      receipt:{company:{inn:"7700000000"},items:[],payments:[],total:50}};
    const result=await new AtolOnlineGateway().registerSell(atol,"SANDBOX",receipt);
    expect(result).toEqual({uuid:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",state:"WAIT"});
    expect(String(mock.mock.calls[1]?.[0]))
      .toBe("https://testonline.atol.ru/possystem/v5/GROUP_01/sell");
    expect(mock.mock.calls[1]?.[1]?.headers).toEqual(
      expect.objectContaining({Token:"valid-token"}));
    expect(String(mock.mock.calls[1]?.[1]?.body)).toContain("corebiz_test");
  });
  it("requires ATOL FN, FD, fiscal sign, external identity and receipt amount",async()=>{
    jest.spyOn(global,"fetch")
      .mockResolvedValueOnce(reply({token:"valid-token"}))
      .mockResolvedValueOnce(reply({
        uuid:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        external_id:"corebiz_payment_prepayment",
        status:"done",error:null,payload:{
          total:120.25,fn_number:"1234567890123456",
          fiscal_document_number:13,fiscal_document_attribute:45678912
        }
      }));
    const result=await new AtolOnlineGateway().report(
      atol,"SANDBOX","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(result).toMatchObject({
      uuid:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      state:"DONE",fnNumber:"1234567890123456",
      documentNumber:13,fiscalSign:"45678912",amountMinor:"12025",
      externalId:"corebiz_payment_prepayment"
    });
  });
  it("rejects provider done without real fiscal requisites",async()=>{
    jest.spyOn(global,"fetch")
      .mockResolvedValueOnce(reply({token:"valid-token"}))
      .mockResolvedValueOnce(reply({
        uuid:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        external_id:"corebiz_test",status:"done",error:null,
        payload:{total:120.25,fn_number:"1234567890123456",
          fiscal_document_number:13}
      }));
    await expect(new AtolOnlineGateway().report(
      atol,"SANDBOX","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
      .rejects.toBeInstanceOf(BadGatewayException);
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
