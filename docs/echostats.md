# Wuthering Waves Echo Stat Reference Data

Use this data to populate sliders, dropdowns, and validation logic in the Echo Editor.

## 1. Main Stat Values (5-Star / Rarity 5 Max Level)
*Note: Primary and Secondary main stats cannot be identical. Values below reflect Level 25 stats. Every Echo has 2 main stats: a randomized primary (tables below) plus a fixed secondary — flat HP on 1-cost, flat ATK on 3/4-cost (flats are secondary-only, never primary).*

### 1-Cost Echoes
Secondary: flat HP (fixed).
| Stat | Value (Min - Max) |
| :--- | :--- |
| HP% | 4.5% - 22.8% |
| ATK% | 3.6% - 18.0% |
| DEF% | 3.6% - 18.0% |

### 3-Cost Echoes
| Stat | Value (Min - Max) |
| :--- | :--- |
| HP% | 6.0% - 30.0% |
| ATK% | 6.0% - 30.0% |
| DEF% | 7.6% - 38.0% |
| Elemental DMG Bonus (All) | 6.0% - 30.0% |
| Energy Regen | 6.4% - 32.0% |


### 4-Cost Echoes
| Stat | Value (Min - Max) |
| :--- | :--- |
| HP% | 6.6% - 33.0% |
| ATK% | 6.6% - 33.0% |
| DEF% | 8.3% - 41.5% |
| Crit. Rate | 4.4% - 22.0% |
| Crit. DMG | 8.8% - 44.0% |
| Healing Bonus | 5.2% - 26.4% |

*Healing Bonus max corrected from 26.0% to 26.4%: observed in-game on a 5★ +25 4-cost Echo (Thousand-Puppet Pavilion), user's recording 2026-10-23. The 5.2% minimum is unverified.*

---

## 2. Substat Possible Roll Values (Discrete)
Substats do not use a continuous range. They roll into one of 8 specific tiers (except Flat ATK/DEF which have 4).

### 8-Tier Stats (% and HP)
| Stat Tier | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **ATK% / HP% / DMG Bonus*** | 6.4% | 7.1% | 7.9% | 8.6% | 9.4% | 10.1% | 10.9% | 11.6% |
| **DEF%** | 8.1% | 9.0% | 10.0% | 10.9% | 11.8% | 12.8% | 13.8% | 14.7% |
| **Energy Regen** | 6.8% | 7.6% | 8.4% | 9.2% | 10.0% | 10.8% | 11.6% | 12.4% |
| **Crit Rate** | 6.3% | 6.9% | 7.5% | 8.1% | 8.7% | 9.3% | 9.9% | 10.5% |
| **Crit DMG** | 12.6% | 13.8% | 15.0% | 16.2% | 17.4% | 18.6% | 19.8% | 21.0% |
| **HP (Flat)** | 320 | 360 | 390 | 430 | 470 | 510 | 540 | 580 |
*\*DMG Bonus includes: Basic, Heavy, Skill, and Liberation.*

### 4-Tier Stats (Flat ATK & DEF)
| Stat Tier | 1 | 2 | 3 | 4 |
| :--- | :--- | :--- | :--- | :--- |
| **ATK (Flat)** | 30 | 40 | 50 | 60 |
| **DEF (Flat)** | 40 | 50 | 60 | 70 |

---

## 3. Implementation Instructions for Antigravity
1. **Dropdown Selection:** When a user selects a Substat type, the slider should "snap" only to the 8 (or 4) discrete values listed above.
2. **Main Stat Scaling:** Main stat sliders should be bounded by the (Min - Max) values corresponding to the selected Echo Cost.
3. **Validation:** Ensure the Primary Main Stat, Secondary Main Stat, and any Substat of the same type (e.g., ATK%) are treated as separate additions to the total character sheet.