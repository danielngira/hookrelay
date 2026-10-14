import assert from "node:assert/strict";
import test from "node:test";
import { eventSchema, runSchema } from "./validation.js";

test("API accepts bounded events and rejects malformed or oversized routing",()=>{
  assert.equal(eventSchema.safeParse({type:"invoice.created",payload:{invoiceId:"inv_1"},destinationIds:["healthy"]}).success,true);
  assert.equal(eventSchema.safeParse({type:"",payload:{},destinationIds:["healthy"]}).success,false);
  assert.equal(eventSchema.safeParse({type:"invoice.created",payload:{},destinationIds:[]}).success,false);
  assert.equal(eventSchema.safeParse({type:"invoice.created",payload:{},destinationIds:["x".repeat(1)] ,unexpected:true}).success,false);
});

test("API bounds run size/concurrency and supplies pass thresholds",()=>{
  const base={scenario:"Healthy delivery",destinationIds:["healthy"],eventCount:40,concurrency:8};
  const parsed=runSchema.safeParse(base);
  assert.equal(parsed.success,true);
  if(parsed.success){assert.equal(parsed.data.maxP95Ms,1000);assert.equal(parsed.data.maxErrorRate,5);}
  assert.equal(runSchema.safeParse({...base,eventCount:501}).success,false);
  assert.equal(runSchema.safeParse({...base,concurrency:0}).success,false);
  assert.equal(runSchema.safeParse({...base,maxErrorRate:101}).success,false);
});
