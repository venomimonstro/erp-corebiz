import {BadGatewayException,ServiceUnavailableException} from "@nestjs/common";
import {RussianPostShipmentGateway,validPostalConsignment} from "./russian-post-shipment.gateway";
const creds={
  accessToken:"exampleAccessToken12345678",
  userAuthorizationKey:"dXNlcm5hbWU6cGFzc3dvcmQ="
};
const order="55555555-5555-4555-8555-555555555555";
const parcel={
  orderNumber:order,recipientName:"Иван Иванов",recipientPhone:"+79990001122",
  destination:{index:"010000",region:"Москва",place:"Москва",
    street:"Ленина",house:"1"},
  massGrams:1200
};
function reply(body:unknown):Response{
  return {ok:true,status:200,headers:{get:()=>null},
    text:async()=>JSON.stringify(body)} as Response;
}
describe("Russian Post backlog safe shipping",()=>{
  afterEach(()=>jest.restoreAllMocks());
  it("uses fixed official PUT endpoint and never treats a backlog ID as a barcode",async()=>{
    const mock=jest.spyOn(global,"fetch")
      .mockResolvedValueOnce(reply({"result-ids":[8342421]}));
    const result=await new RussianPostShipmentGateway().create(creds,parcel);
    expect(result).toEqual({providerId:"8342421"});
    const [url,init]=mock.mock.calls[0]!;
    expect(url).toBe("https://otpravka-api.pochta.ru/1.0/user/backlog");
    expect(init?.method).toBe("PUT");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual(expect.objectContaining({
      Authorization:"AccessToken "+creds.accessToken,
      "X-User-Authorization":"Basic "+creds.userAuthorizationKey
    }));
    const body=JSON.parse(String(init?.body));
    expect(body).toHaveLength(1);
    expect(body[0]["order-num"]).toBe(order);
    expect(body[0]["index-to"]).toBe(10000);
    expect(body[0].payment).toBeUndefined();
  });
  it("does not promote provider HTTP 200 with errors to created",async()=>{
    jest.spyOn(global,"fetch").mockResolvedValueOnce(
      reply({errors:[{"position":0}]}));
    await expect(new RussianPostShipmentGateway().create(creds,parcel))
      .rejects.toBeInstanceOf(BadGatewayException);
  });
  it("refuses malformed postal address before any provider API mutation",async()=>{
    const fetchMock=jest.spyOn(global,"fetch");
    expect(validPostalConsignment({...parcel,destination:{
      ...parcel.destination,street:""
    }})).toBe(false);
    await expect(new RussianPostShipmentGateway().create(creds,{
      ...parcel,destination:{...parcel.destination,index:"1234"}
    })).rejects.toBeInstanceOf(BadGatewayException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("reconciles exact merchant order ID and rejects unrelated data",async()=>{
    const mock=jest.spyOn(global,"fetch")
      .mockResolvedValueOnce(reply([{id:101,"order-num":order,
        barcode:"12345678901234"}]));
    const found=await new RussianPostShipmentGateway()
      .findByOrderNumber(creds,order);
    expect(found).toEqual({providerId:"101",orderNumber:order,
      barcode:"12345678901234"});
    expect(String(mock.mock.calls[0]![0])).toContain(
      "/backlog/search?query="+order);
  });
  it("returns no match rather than claiming an unknown order is shipped",async()=>{
    jest.spyOn(global,"fetch").mockResolvedValueOnce(
      reply([{id:101,"order-num":"88888888-8888-4888-8888-888888888888"}]));
    await expect(new RussianPostShipmentGateway()
      .findByOrderNumber(creds,order)).resolves.toBeNull();
  });
  it("fails closed when lookup API is unavailable",async()=>{
    jest.spyOn(global,"fetch").mockRejectedValueOnce(new Error("timeout"));
    await expect(new RussianPostShipmentGateway().findByOrderNumber(
      creds,order)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
