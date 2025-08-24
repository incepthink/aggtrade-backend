import Redis from "ioredis";

class RedisSingleton {
  constructor() {
    //@ts-ignore
    if (!RedisSingleton.instance) {
      try {
        //@ts-ignore
        RedisSingleton.instance = new Redis(process.env.REDIS_URL);
      } catch (error) {
        console.log("redis error", error);
      }
    }
  }

  getInstance() {
    //@ts-ignore
    return RedisSingleton.instance;
  }
}

// Store a value with an expiration of 2 minutes
export const storeValue = async (key: string, value: any, ex: number) => {
  try {
    await redis.set(key, value, "EX", ex); // 'EX' sets the expiration time in seconds
  } catch (error) {
    console.error("Error setting value:", error);
  }
};

// Force deletion of a value before expiration
export const deleteValue = async (key: string) => {
  try {
    await redis.del(key);
  } catch (error) {
    console.error("Error deleting value:", error);
  }
};

// Retrieve a value
export const getValue = async (key: string) => {
  try {
    const value = await redis.get(key);
    return value;
  } catch (error) {
    console.error("Error getting value:", error);
    return null;
  }
};

export const redis = new RedisSingleton().getInstance();
