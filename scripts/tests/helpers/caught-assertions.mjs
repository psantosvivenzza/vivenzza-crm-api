import nodeTest from 'node:test'
import strictAssert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'

// Preserve assertions even when an injected callback is caught by the real SUT.
const scope = new AsyncLocalStorage()
const call = (fn, receiver, args) => {
 try { return Reflect.apply(fn, receiver, args) }
 catch(error) { scope.getStore()?.push(error); throw error }
}
export const assert = new Proxy(strictAssert, {
 apply(fn, receiver, args) { return call(fn, receiver, args) },
 get(target, key) {
  const value=Reflect.get(target,key)
  return typeof value==='function'?(...args)=>call(value,target,args):value
 },
})
export function test(name, fn) {
 return nodeTest(name, async context => {
  const failures=[]
  await scope.run(failures,()=>fn(context))
  strictAssert.equal(failures.length,0,'Assertion failed inside a callback caught by the SUT')
 })
}
