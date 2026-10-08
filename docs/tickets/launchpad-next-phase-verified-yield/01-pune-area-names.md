# 01: Pune area names count as Pune

**What to build:** A listing that names a Pune area (Kalyani Nagar, Hadapsar, Yerwada, Balewadi, Pimpri, Chinchwad) passes as Pune even without the word "Pune". Short names that also exist elsewhere pass only with Maharashtra, MH, or a 411xxx/412xxx pin code. The outer industrial belt (Chakan, Talegaon, Ranjangaon, Shikrapur) is rejected. Multi-city listings that include Pune pass.

**Blocked by:** None (can start immediately)

**Status:** done

- [ ] Kalyani Nagar listing without "Pune" passes as Pune
- [ ] Ambiguous short name alone does not pass as Pune
- [ ] Same short name with Maharashtra or a 411/412 pin passes
- [ ] Chakan listing is rejected
- [ ] Multi-city listing that includes Pune passes
- [ ] Regression tests use real listings
