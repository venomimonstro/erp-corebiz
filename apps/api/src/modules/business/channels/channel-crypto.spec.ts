import {ChannelCryptoService} from "./channel-crypto.service";

jest.mock("../../../infrastructure/config/env",()=>({
  getEnv:()=>({sessionSecret:"legacy-session-secret-for-migration-tests"})
}));

describe("marketplace credential encryption key separation",()=>{
  const saved=process.env.CHANNEL_ENCRYPTION_KEY;
  afterEach(()=>{
    if(saved===undefined)delete process.env.CHANNEL_ENCRYPTION_KEY;
    else process.env.CHANNEL_ENCRYPTION_KEY=saved;
  });
  it("legacy v1 credentials remain readable after enabling a separate v2 key",()=>{
    delete process.env.CHANNEL_ENCRYPTION_KEY;
    const legacy=new ChannelCryptoService();
    const stored=legacy.encrypt({apiKey:"marketplace-private"});
    expect(stored.startsWith("v1.")).toBe(true);

    process.env.CHANNEL_ENCRYPTION_KEY="channel-only-secret-for-new-credentials-at-least-32-chars";
    const rotated=new ChannelCryptoService();
    expect(rotated.decrypt(stored)).toEqual({apiKey:"marketplace-private"});
    const newer=rotated.encrypt({apiKey:"replacement"});
    expect(newer.startsWith("v2.")).toBe(true);
    expect(rotated.decrypt(newer)).toEqual({apiKey:"replacement"});
  });
  it("v2 credentials cannot be decrypted without dedicated channel key",()=>{
    process.env.CHANNEL_ENCRYPTION_KEY="channel-secret-separate-from-login-token-rotation";
    const ciphertext=new ChannelCryptoService().encrypt({apiToken:"not-session"});
    delete process.env.CHANNEL_ENCRYPTION_KEY;
    expect(()=>new ChannelCryptoService().decrypt(ciphertext))
      .toThrow("CHANNEL_ENCRYPTION_KEY_REQUIRED_FOR_V2");
  });
  it("modifying ciphertext or authentication tag is detected",()=>{
    process.env.CHANNEL_ENCRYPTION_KEY="standalone-channel-secret-for-authenticated-encryption";
    const crypto=new ChannelCryptoService();
    const value=crypto.encrypt({apiKey:"secret"});
    const parts=value.split(".");
    parts[2]=parts[2]!.replace(/^./,parts[2]![0]==="A"?"B":"A");
    expect(()=>crypto.decrypt(parts.join("."))).toThrow();
  });
});
