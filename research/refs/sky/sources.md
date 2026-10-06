# 西安晴天参考照片来源（维基共享资源）

- 01_olympic_center_aerial.jpg：File:Xi'an Olympic Sports Center(Aerial image).jpg（4000×2250，CC BY-SA 4.0，Liuboyoupeter，2021-06-19）
  https://commons.wikimedia.org/wiki/File:Xi%27an_Olympic_Sports_Center(Aerial_image).jpg
- 02_changan_tower_aerial.jpg：File:西安世园会长安塔.jpg（4000×2250，CC BY-SA 4.0，Liuboyoupeter，2021-03-14）
  https://commons.wikimedia.org/wiki/File:%E8%A5%BF%E5%AE%89%E4%B8%96%E5%9B%AD%E4%BC%9A%E9%95%BF%E5%AE%89%E5%A1%94.jpg
- 03_xiaozhai_aerial.jpg：File:Aerial View of Xiaozhai Crossings, Sep 17 2023.jpg（4032×3024，CC BY-SA 4.0，A Chinese ID，2023-09-17 18:47:54）
  https://commons.wikimedia.org/wiki/File:Aerial_View_of_Xiaozhai_Crossings,_Sep_17_2023.jpg
- 04_cbd_skyline.jpg：File:Skyline of Xi'an CBD.jpg（1978×1825，CC0，Derxxxxx，2023-08-23）
  https://commons.wikimedia.org/wiki/File:Skyline_of_Xi%27an_CBD.jpg
- 05_view_from_belltower.jpg：File:View from the bell tower - panoramio.jpg（2592×1952，CC BY-SA 3.0，Daugilas，Taken on 6 March 2011）
  https://commons.wikimedia.org/wiki/File:View_from_the_bell_tower_-_panoramio.jpg
- 06_chanba_school_aerial.jpg：File:西大附中浐灞中学（俯视图）.jpg（4000×2250，CC BY-SA 4.0，Liu Boyou，2020/9/11）
  https://commons.wikimedia.org/wiki/File:%E8%A5%BF%E5%A4%A7%E9%99%84%E4%B8%AD%E6%B5%90%E7%81%9E%E4%B8%AD%E5%AD%A6%EF%BC%88%E4%BF%AF%E8%A7%86%E5%9B%BE%EF%BC%89.jpg
- 07_zhongnan_distance.jpg：File:20240321 Zhongnan Mountains in Xi'an 01.jpg（1800×1200，CC BY-SA 4.0，Windmemories，2024-03-21 16:29:29）
  https://commons.wikimedia.org/wiki/File:20240321_Zhongnan_Mountains_in_Xi%27an_01.jpg
- 08_bell_drum_tower.jpg：File:Bell Tower and Drum Tower, Xi'an, China - panoramio.jpg（3456×1835，CC BY-SA 3.0，Aaron Zhu，Taken on 18 June 2016）
  https://commons.wikimedia.org/wiki/File:Bell_Tower_and_Drum_Tower,_Xi%27an,_China_-_panoramio.jpg

## 从参考照片归纳的白天目标（2026-10-06）

- 天空：天顶深蓝→地平线淡蓝有层次；参考照天顶带 sRGB 约 (140~165, 155~175, 165~185)，b/r ≈ 1.1~1.3（照片多为轻霾天，晴天应更蓝）。
- 地面：饱和不发白，近景带均值约 85~115，b/r ≈ 0.86~0.96（偏中性/暖，不能整体泛蓝）。
- 远景：5~10 km 略带薄霾但建筑轮廓可辨；远景带亮度明显低于地平线天空（照片里约为其 0.6~0.7 倍）。
- 阴影清晰但不死黑：直射光 : 天光 ≈ 3~4 : 1。
- 修改前截图（shots/before）：天顶带 (236,245,250)、远景带 (199,213,221)、近景 b/r 1.23 —— 整体发白、泛蓝；
  修改后（shots/after）：天顶带 (152,190,206) b/r 1.35、远景带 (120,118,114)、近景 b/r 1.01。
- 测量脚本：对截图按横带取均值（天顶带 0~6%、远景带 地平线下 0.5~6%、近景带 75~95%）。
