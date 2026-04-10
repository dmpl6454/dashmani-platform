"use client";
import { Building2, Users, Target, Globe, Award, Heart } from "lucide-react";

const cardClass = "bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-6";

export default function CompanyProfilePage() {
  return (
    <div className="min-h-screen bg-[#FEFCF7] p-6 md:p-10 space-y-8">
      {/* Hero */}
      <div className="bg-gradient-to-br from-[#1A1A1A] to-[#333] rounded-2xl p-8 md:p-12 text-white">
        <div className="flex items-center gap-4 mb-6">
          <div className="h-16 w-16 rounded-2xl bg-[#F5D547] flex items-center justify-center">
            <Building2 className="h-8 w-8 text-[#1A1A1A]" />
          </div>
          <div>
            <h1 className="text-3xl font-serif font-light">Dashmani Media Pvt. Ltd.</h1>
            <p className="text-white/60 text-sm mt-1">Parent Company</p>
          </div>
        </div>
        <p className="text-white/80 text-sm leading-relaxed max-w-3xl">
          Dashmani Media Private Limited is a full-service media and marketing agency headquartered in India. We specialize in digital marketing, social media management, content creation, influencer marketing, and brand strategy. Our mission is to help brands grow their digital presence through innovative and data-driven marketing solutions.
        </p>
      </div>

      {/* Digital Sukoon */}
      <div className={cardClass}>
        <div className="flex items-center gap-4 mb-5">
          <div className="h-14 w-14 rounded-2xl bg-[#FFF3C4] flex items-center justify-center">
            <Globe className="h-7 w-7 text-[#B8960C]" />
          </div>
          <div>
            <h2 className="text-2xl font-serif font-light text-[#1A1A1A]">Digital Sukoon</h2>
            <p className="text-sm text-[#7A7A7A]">A Dashmani Media Initiative</p>
          </div>
        </div>
        <p className="text-sm text-[#555] leading-relaxed mb-6">
          Digital Sukoon is a social media marketing and management agency under Dashmani Media. We provide end-to-end social media services including content planning, graphic design, video production, influencer collaborations, paid advertising, and analytics reporting. We work with brands across industries to build authentic online communities and drive measurable business results.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-[#FEFCF7] border border-[#F0EAD8] rounded-xl p-4 text-center">
            <Users className="h-6 w-6 mx-auto mb-2 text-[#B8960C]" />
            <p className="text-2xl font-semibold text-[#1A1A1A]">50+</p>
            <p className="text-xs text-[#7A7A7A]">Team Members</p>
          </div>
          <div className="bg-[#FEFCF7] border border-[#F0EAD8] rounded-xl p-4 text-center">
            <Award className="h-6 w-6 mx-auto mb-2 text-[#B8960C]" />
            <p className="text-2xl font-semibold text-[#1A1A1A]">200+</p>
            <p className="text-xs text-[#7A7A7A]">Clients Served</p>
          </div>
          <div className="bg-[#FEFCF7] border border-[#F0EAD8] rounded-xl p-4 text-center">
            <Target className="h-6 w-6 mx-auto mb-2 text-[#B8960C]" />
            <p className="text-2xl font-semibold text-[#1A1A1A]">500+</p>
            <p className="text-xs text-[#7A7A7A]">Social Accounts Managed</p>
          </div>
        </div>
      </div>

      {/* Values */}
      <div className={cardClass}>
        <h2 className="text-xl font-serif font-light text-[#1A1A1A] mb-5 flex items-center gap-2">
          <Heart className="h-5 w-5 text-[#F5D547]" /> Our Values
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            { title: "Innovation", desc: "We embrace new technologies and creative approaches to stay ahead in the digital landscape." },
            { title: "Integrity", desc: "We maintain transparency and honesty in all our dealings with clients and team members." },
            { title: "Collaboration", desc: "We believe in teamwork and fostering a supportive environment where everyone can thrive." },
            { title: "Excellence", desc: "We strive for the highest quality in everything we deliver, from content to client relationships." },
            { title: "Growth Mindset", desc: "We encourage continuous learning and personal development for every team member." },
            { title: "Client First", desc: "Our clients' success is our success. We go above and beyond to deliver exceptional results." },
          ].map((v, i) => (
            <div key={i} className="bg-[#FEFCF7] border border-[#F0EAD8] rounded-xl p-4">
              <h3 className="font-semibold text-[#1A1A1A] text-sm mb-1">{v.title}</h3>
              <p className="text-xs text-[#7A7A7A] leading-relaxed">{v.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Services */}
      <div className={cardClass}>
        <h2 className="text-xl font-serif font-light text-[#1A1A1A] mb-5">Our Services</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[
            "Social Media Management",
            "Content Creation & Strategy",
            "Influencer Marketing",
            "Paid Advertising (Meta, Google)",
            "Brand Strategy & Consulting",
            "Video Production & Editing",
            "Graphic Design",
            "SEO & Web Development",
            "Analytics & Reporting",
          ].map((s, i) => (
            <div key={i} className="bg-[#FFF3C4]/30 border border-[#F5D547]/20 rounded-lg px-3 py-2.5 text-sm text-[#1A1A1A] font-medium text-center">
              {s}
            </div>
          ))}
        </div>
      </div>

      {/* Contact */}
      <div className="bg-[#1A1A1A] rounded-2xl p-6 text-white text-center">
        <p className="text-sm text-white/60 mb-1">Company Registered Office</p>
        <p className="font-serif text-lg">Dashmani Media Private Limited</p>
        <p className="text-sm text-white/60 mt-2">For any queries, contact HR at <a href="mailto:hr@digitalsukoon.com" className="text-[#F5D547] hover:underline">hr@digitalsukoon.com</a></p>
      </div>
    </div>
  );
}
